// 웹툰·만화 컷 분할기
// 1) 영역의 테두리에서 배경색을 추정하고, 그 색의 여백(거터)으로 재귀적으로 자른다 (XY-cut)
// 2) 잘린 영역의 테두리가 다른 단색(흰 스트립, 검은 외곽선 등)이면 그 색으로 한 번 더 다듬는다
// 3) 여백·외곽선·경계 흐림까지 깎아 그림만 남기고, 본문 열 밖의 조각(브라우저 UI, 광고 칸)은 버린다
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

public static class PanelCutter
{
    static byte[] L;
    static int W, H, GlobalBg, Tol, MinGap, MinSize, MaxDepth = 8;
    static bool AllowCols, Rtl, Tight = true, KeepText, PreserveBounds;
    static int Skipped;
    static List<Int32Rect> Found;
    static bool Dbg = Environment.GetEnvironmentVariable("FLASH_CUT_DEBUG") == "1";

    public static string Run(string input, string outDir, string prefix, int minGap, int tol, string mode, int minSize, int pad, bool rtl, int maxPanels, bool keepAll, bool tight, bool keepText)
    {
        return Run(input, outDir, prefix, minGap, tol, mode, minSize, pad, rtl, maxPanels, keepAll, tight, keepText, false);
    }

    public static string Run(string input, string outDir, string prefix, int minGap, int tol, string mode, int minSize, int pad, bool rtl, int maxPanels, bool keepAll, bool tight, bool keepText, bool preserveBounds)
    {
        var dec = BitmapDecoder.Create(new Uri(input), BitmapCreateOptions.IgnoreColorProfile, BitmapCacheOption.OnLoad);
        BitmapSource src = dec.Frames[0];
        if (src.Format != PixelFormats.Bgra32) src = new FormatConvertedBitmap(src, PixelFormats.Bgra32, null, 0);
        W = src.PixelWidth; H = src.PixelHeight;
        int stride = W * 4;
        var px = new byte[(long)stride * H];
        src.CopyPixels(px, stride, 0);
        L = new byte[(long)W * H];
        for (long i = 0, j = 0; i < L.Length; i++, j += 4)
        {
            int lum = (px[j + 2] * 299 + px[j + 1] * 587 + px[j] * 114) / 1000;
            L[i] = (byte)(px[j + 3] < 16 ? 255 : lum);
        }
        px = null;

        Tol = tol; MinGap = minGap; MinSize = minSize; Rtl = rtl; Tight = tight; KeepText = keepText; PreserveBounds = preserveBounds; Skipped = 0;
        AllowCols = mode != "vertical";
        int f;
        GlobalBg = BorderMode(0, 0, W, H, out f);
        Found = new List<Int32Rect>();

        // 구조 판단: 위에서 아래까지 이어지는 세로 여백이 안쪽에 있으면 격자형(인스타툰 등) → 열 먼저 나눈다
        List<int[]> cols = GridColumns();
        string layout;
        List<Int32Rect> panels;
        if (mode == "columns" || (mode == "auto" && cols.Count >= 2))
        {
            layout = "columns";
            panels = ColumnGrid(cols.Count >= 2 ? cols : new List<int[]> { new[] { 0, W } });
        }
        else
        {
            layout = mode == "auto" ? "vertical" : mode;
            Cut(0, 0, W, H, 0, true, GlobalBg, true);
            panels = keepAll || PreserveBounds ? Found : MainColumn(Found);
        }
        LayoutInfo = "\"gridRaw\":\"" + GridRaw + "\",\"layout\":\"" + layout + "\",\"columns\":" + Math.Max(1, cols.Count) + ",";

        Directory.CreateDirectory(outDir);
        var sb = new StringBuilder();
        sb.Append("{").Append(LayoutInfo).Append("\"width\":").Append(W).Append(",\"height\":").Append(H).Append(",\"background\":").Append(GlobalBg).Append(",\"panels\":[");
        int n = 0;
        foreach (var r0 in panels)
        {
            if (n >= maxPanels) break;
            int x = Math.Max(0, r0.X - pad), y = Math.Max(0, r0.Y - pad);
            int w = Math.Min(W - x, r0.Width + pad * 2), h = Math.Min(H - y, r0.Height + pad * 2);
            var enc = new PngBitmapEncoder();
            enc.Frames.Add(BitmapFrame.Create(new CroppedBitmap(src, new Int32Rect(x, y, w, h))));
            string name = prefix + "_" + (n + 1).ToString("00") + ".png";
            using (var fs = File.Create(Path.Combine(outDir, name))) enc.Save(fs);
            if (n > 0) sb.Append(',');
            sb.Append("{\"file\":\"").Append(name).Append("\",\"x\":").Append(x).Append(",\"y\":").Append(y)
              .Append(",\"w\":").Append(w).Append(",\"h\":").Append(h).Append('}');
            n++;
        }
        sb.Append("],\"detected\":").Append(Found.Count).Append(",\"kept\":").Append(panels.Count).Append(",\"textBoxesSkipped\":").Append(Skipped).Append('}');
        return sb.ToString();
    }

    // 영역 테두리에서 가장 흔한 밝기와 그 비율(0~100). 바깥 테두리선을 피하려고 안쪽 0~4px 링 중 가장 균일한 것을 쓴다
    // 여백이 될 수 있는 색(흰색·전체 배경색)인 링을 우선한다
    static int BorderMode(int x0, int y0, int x1, int y1, out int pct, int currentBg = -1)
    {
        int best = RingMode(x0, y0, x1, y1, out pct);
        int sBest = -1, sPct = 0;
        for (int k = 0; k <= 4 && x1 - x0 > 2 * k + 2 && y1 - y0 > 2 * k + 2; k++)
        {
            int p;
            int m = RingMode(x0 + k, y0 + k, x1 - k, y1 - k, out p);
            if (p > pct) { pct = p; best = m; }
            bool splitColor = m >= 200 || Math.Abs(m - GlobalBg) <= Tol;
            if (splitColor && Math.Abs(m - currentBg) > Tol && p >= 40 && p > sPct) { sPct = p; sBest = m; }
        }
        if (sBest >= 0) { pct = sPct; return sBest; }
        return best;
    }

    static int RingMode(int x0, int y0, int x1, int y1, out int pct)
    {
        var hist = new int[256];
        int total = 0;
        for (int x = x0; x < x1; x++) { hist[L[(long)y0 * W + x]]++; hist[L[(long)(y1 - 1) * W + x]]++; total += 2; }
        for (int y = y0; y < y1; y++) { hist[L[(long)y * W + x0]]++; hist[L[(long)y * W + x1 - 1]]++; total += 2; }
        int best = 0;
        for (int v = 0; v < 256; v++) if (hist[v] > hist[best]) best = v;
        int near = 0;
        for (int v = Math.Max(0, best - Tol); v <= Math.Min(255, best + Tol); v++) near += hist[v];
        pct = total == 0 ? 0 : near * 100 / total;
        return best;
    }

    static bool RowIsGutter(int y, int x0, int x1, int bg)
    {
        int bad = 0, limit = PreserveBounds ? 0 : Math.Max(1, (x1 - x0) / 250);
        long o = (long)y * W;
        for (int x = x0; x < x1; x++) if (Math.Abs(L[o + x] - bg) > (PreserveBounds ? Math.Min(Tol, 3) : Tol) && ++bad > limit) return false;
        return true;
    }

    static bool ColIsGutter(int x, int y0, int y1, int bg)
    {
        int bad = 0, limit = PreserveBounds ? 0 : Math.Max(1, (y1 - y0) / 250);
        for (int y = y0; y < y1; y++) if (Math.Abs(L[(long)y * W + x] - bg) > (PreserveBounds ? Math.Min(Tol, 3) : Tol) && ++bad > limit) return false;
        return true;
    }

    // 경계의 흐린(안티앨리어싱) 줄: 평균이 배경에 가까우면 추가로 깎는다
    static bool RowIsSoft(int y, int x0, int x1, int bg)
    {
        long sum = 0; long o = (long)y * W;
        for (int x = x0; x < x1; x++) sum += Math.Abs(L[o + x] - bg);
        return sum <= (long)(x1 - x0) * Tol * 3;
    }

    static bool ColIsSoft(int x, int y0, int y1, int bg)
    {
        long sum = 0;
        for (int y = y0; y < y1; y++) sum += Math.Abs(L[(long)y * W + x] - bg);
        return sum <= (long)(y1 - y0) * Tol * 3;
    }

    static bool LineUniform(bool isRow, int idx, int a, int b)
    {
        var hist = new int[256];
        int n = b - a;
        if (n <= 0) return false;
        for (int v = a; v < b; v++) hist[isRow ? L[(long)idx * W + v] : L[(long)v * W + idx]]++;
        int best = 0;
        for (int v = 0; v < 256; v++) if (hist[v] > hist[best]) best = v;
        int near = 0;
        for (int v = Math.Max(0, best - Tol); v <= Math.Min(255, best + Tol); v++) near += hist[v];
        return near >= n * 0.9;
    }

    static void Trim(ref int x0, ref int y0, ref int x1, ref int y1, int bg)
    {
        while (y0 < y1 && RowIsGutter(y0, x0, x1, bg)) y0++;
        while (y1 > y0 && RowIsGutter(y1 - 1, x0, x1, bg)) y1--;
        while (x0 < x1 && ColIsGutter(x0, y0, y1, bg)) x0++;
        while (x1 > x0 && ColIsGutter(x1 - 1, y0, y1, bg)) x1--;
        if (PreserveBounds) return;
        // 얇은 단색 테두리선(최대 4px): 90% 이상이 한 색이면 깎는다
        for (int k = 0; k < 4 && y1 - y0 > MinSize && LineUniform(true, y0, x0, x1); k++) y0++;
        for (int k = 0; k < 4 && y1 - y0 > MinSize && LineUniform(true, y1 - 1, x0, x1); k++) y1--;
        for (int k = 0; k < 4 && x1 - x0 > MinSize && LineUniform(false, x0, y0, y1); k++) x0++;
        for (int k = 0; k < 4 && x1 - x0 > MinSize && LineUniform(false, x1 - 1, y0, y1); k++) x1--;
        for (int k = 0; k < 3 && y1 - y0 > MinSize && RowIsSoft(y0, x0, x1, bg); k++) y0++;
        for (int k = 0; k < 3 && y1 - y0 > MinSize && RowIsSoft(y1 - 1, x0, x1, bg); k++) y1--;
        for (int k = 0; k < 3 && x1 - x0 > MinSize && ColIsSoft(x0, y0, y1, bg); k++) x0++;
        for (int k = 0; k < 3 && x1 - x0 > MinSize && ColIsSoft(x1 - 1, y0, y1, bg); k++) x1--;
    }

    static void Cut(int x0, int y0, int x1, int y1, int depth, bool rowsFirst, int bg, bool canSplit)
    {
        Trim(ref x0, ref y0, ref x1, ref y1, bg);
        if (x1 - x0 < MinSize || y1 - y0 < MinSize) return;

        if (depth < MaxDepth)
        {
            // 테두리가 다른 단색이면 그 색을 새 배경으로 삼는다.
            // 밝은 색(흰 여백)이나 전체 배경과 같은 색일 때만 분할까지 허용하고, 그 외(검은 외곽선, 어두운 장면)는 다듬기만 한다
            int pct;
            int local = BorderMode(x0, y0, x1, y1, out pct, bg);
            bool splitColor = local >= 200 || Math.Abs(local - GlobalBg) <= Tol;
            if (!PreserveBounds && Math.Abs(local - bg) > Tol && (pct >= 90 || (splitColor && pct >= 40)))
            {
                Cut(x0, y0, x1, y1, depth + 1, rowsFirst, local, splitColor);
                return;
            }

            if (canSplit)
            {
                // 현재 배경색 → 흰색 → 전체 배경색 순서로 여백을 찾아본다 (흰 스트립 안의 검은 구간 등)
                var colors = new List<int> { bg };
                foreach (int c in (PreserveBounds ? new int[0] : new[] { local, 255, 0, GlobalBg }))
                    if (colors.TrueForAll(o => Math.Abs(o - c) > Tol)) colors.Add(c);
                foreach (int color in colors)
                {
                    for (int pass = 0; pass < 2; pass++)
                    {
                        bool byRows = (pass == 0) == rowsFirst;
                        if (!byRows && !AllowCols) continue;
                        int X0 = x0, Y0 = y0, X1 = x1, Y1 = y1, C = color;
                        var segs = byRows ? Split(y0, y1, v => RowIsGutter(v, X0, X1, C)) : Split(x0, x1, v => ColIsGutter(v, Y0, Y1, C));
                        if (segs.Count < 2) continue;
                        if (!byRows && Rtl) segs.Reverse();
                        foreach (var s in segs)
                        {
                            if (byRows) Cut(x0, s[0], x1, s[1], depth + 1, !rowsFirst, color, true);
                            else Cut(s[0], y0, s[1], y1, depth + 1, !rowsFirst, color, true);
                        }
                        return;
                    }
                }
            }
        }
        Leaf(x0, y0, x1, y1, bg);
    }

    // 잎 영역: 그림이 채워진 첫 줄~마지막 줄, 첫 열~마지막 열만 남긴다 (바깥 여백·여백에 걸친 말풍선 제거)
    static void Leaf(int x0, int y0, int x1, int y1, int bg)
    {
        if (PreserveBounds || !Tight) { Found.Add(new Int32Rect(x0, y0, x1 - x0, y1 - y0)); return; }
        int w = x1 - x0, h = y1 - y0;
        int top = -1, bottom = -1;
        for (int y = y0; y < y1; y++)
        {
            int c = 0; long o = (long)y * W;
            for (int x = x0; x < x1; x++) if (Math.Abs(L[o + x] - bg) > Tol) c++;
            if (c >= w * 0.6) { if (top < 0) top = y; bottom = y + 1; }
        }
        int ax0 = x0, ay0 = y0, ax1 = x1, ay1 = y1;
        if (top >= 0 && bottom - top >= MinSize)
        {
            ay0 = top; ay1 = bottom;
            int left = -1, right = -1;
            for (int x = x0; x < x1; x++)
            {
                int c = 0;
                for (int y = ay0; y < ay1; y++) if (Math.Abs(L[(long)y * W + x] - bg) > Tol) c++;
                if (c >= (ay1 - ay0) * 0.6) { if (left < 0) left = x; right = x + 1; }
            }
            if (left >= 0 && right - left >= Math.Max(MinSize, w * 0.6)) { ax0 = left; ax1 = right; }
            Trim(ref ax0, ref ay0, ref ax1, ref ay1, bg);
            if (ax1 - ax0 < MinSize || ay1 - ay0 < MinSize) return;
        }

        if (!KeepText)
        {
            // 글자 상자(잉크 12% 미만)나 그라데이션·단색 띠(거의 모든 줄이 단색)는 그림이 아니므로 뺀다
            long ink = 0; int flat = 0;
            for (int y = ay0; y < ay1; y++)
            {
                long o = (long)y * W;
                for (int x = ax0; x < ax1; x++) if (Math.Abs(L[o + x] - bg) > Tol) ink++;
                if (LineUniform(true, y, ax0, ax1)) flat++;
            }
            double inkRatio = (double)ink / ((long)(ax1 - ax0) * (ay1 - ay0));
            if (inkRatio < 0.12 || flat >= (ay1 - ay0) * 0.9) { Skipped++; return; }
        }
        Found.Add(new Int32Rect(ax0, ay0, ax1 - ax0, ay1 - ay0));
    }

    static List<int[]> Split(int a, int b, Func<int, bool> isGutter)
    {
        var segs = new List<int[]>();
        int start = a, run = 0;
        for (int v = a; v < b; v++)
        {
            if (isGutter(v)) { run++; continue; }
            if (run >= MinGap) { if (v - run > start) segs.Add(new[] { start, v - run }); start = v; }
            run = 0;
        }
        if (b - run > start) segs.Add(new[] { start, b - run });
        return segs;
    }

    // ---------------- 격자형(열 우선) ----------------
    static string LayoutInfo = "", GridRaw = "";
    static bool Ink(long o) { return Math.Abs(L[o] - GlobalBg) > Tol; }

    // 프로필에서 여백이 아닌 구간 [a,b) 목록. gutter(v) 가 minRun 이상 이어지면 끊는다
    static List<int[]> Bands(int len, Func<int, bool> gutter, int minRun)
    {
        var segs = new List<int[]>();
        int start = -1, run = 0;
        for (int v = 0; v < len; v++)
        {
            if (gutter(v)) { run++; if (start >= 0 && run >= minRun) { segs.Add(new[] { start, v - run + 1 }); start = -1; } continue; }
            if (start < 0) start = v;
            run = 0;
        }
        if (start >= 0) segs.Add(new[] { start, len - run });
        return segs;
    }

    // 잉크 개수 프로필을 비율(0~1)로 바꾸고 좁게 부드럽게 한다
    static double[] Smooth(int[] prof, int denom)
    {
        int len = prof.Length, win = Math.Max(3, len / 1000);
        var sm = new double[len];
        double acc = 0;
        for (int i = 0; i < len; i++)
        {
            acc += prof[i];
            if (i >= win) acc -= prof[i - win];
            sm[Math.Max(0, i - win / 2)] = acc / Math.Min(i + 1, win) / Math.Max(1, denom);
        }
        return sm;
    }

    static double Median(double[] sm, double from, double to)
    {
        var v = new List<double>();
        for (int i = (int)(sm.Length * from); i < sm.Length * to; i++) v.Add(sm[i]);
        v.Sort();
        return v.Count > 0 ? v[v.Count / 2] : 0;
    }

    // 균등 격자 가정: n칸(nMin~nMax)이라면 경계가 있어야 할 자리(len·i/n 근처)마다 뚜렷한 골짜기가 있는지 본다.
    // 모든 경계가 골짜기인 n 중 가장 큰 것의 경계 위치를 돌려준다. 없으면 null
    static List<int> UniformCuts(double[] sm, int nMin, int nMax, double median, StringBuilder log)
    {
        int len = sm.Length;
        List<int> cuts = null;
        for (int n = nMin; n <= nMax; n++)
        {
            var found = new List<int>();
            int span = len / (3 * n), around = len / (4 * n);
            for (int i = 1; i < n && found.Count == i - 1; i++)
            {
                int e = (int)((long)len * i / n), bx = -1;
                for (int x = Math.Max(1, e - span); x < Math.Min(len - 1, e + span); x++) if (bx < 0 || sm[x] < sm[bx]) bx = x;
                if (bx < 0) break;
                double peak = 0;
                for (int k = Math.Max(0, bx - around); k < Math.Min(len, bx + around); k++) peak = Math.Max(peak, sm[k]);
                bool valley = sm[bx] <= median * 0.4 && sm[bx] <= peak * 0.45 && sm[bx] <= 0.2;
                log.Append(n).Append(':').Append(bx).Append('=').Append(sm[bx].ToString("0.000")).Append(valley ? "v " : "x ");
                if (valley) found.Add(bx);
            }
            if (found.Count == n - 1) cuts = found;
        }
        return cuts;
    }

    static List<int[]> ToBands(List<int> cuts, int len)
    {
        var bands = new List<int[]>();
        int prev = 0;
        foreach (int c in cuts) { bands.Add(new[] { prev, c }); prev = c; }
        bands.Add(new[] { prev, len });
        return bands;
    }

    // 열 판정: 줄마다 컷 가장자리가 어긋나 순백 여백은 아주 좁으므로, "빈 줄" 대신 잉크 분포의 골짜기를 균등 간격으로 찾는다
    static List<int[]> GridColumns()
    {
        var colInk = new int[W];
        for (int y = 0; y < H; y++) { long o = (long)y * W; for (int x = 0; x < W; x++) if (Ink(o + x)) colInk[x]++; }
        var sm = Smooth(colInk, H);
        double median = Median(sm, 0.12, 0.88);
        // 안쪽이 대부분 여백이면(좌우 띠가 넓은 캡처 등) 격자가 아니다
        if (median < 0.08) { GridRaw = "cols median " + median.ToString("0.000") + " (여백 위주 — 격자 아님)"; return new List<int[]>(); }
        var log = new StringBuilder();
        var cuts = UniformCuts(sm, 2, 5, median, log);
        GridRaw = "cols median " + median.ToString("0.000") + " " + log;
        if (cuts == null) return new List<int[]>();
        var cols = ToBands(cuts, W);
        int mn = int.MaxValue, mx = 0;
        foreach (var c in cols) { mn = Math.Min(mn, c[1] - c[0]); mx = Math.Max(mx, c[1] - c[0]); }
        if (mn < mx * 0.6) return new List<int[]>();
        return cols;
    }

    // 예상 구간 [a,b) 와 가장 많이 겹치는 덩어리를 고르고, 바로 붙어 있는(간격 ≤ join) 이웃 덩어리는 합친다
    // (컷 위아래에 붙은 설명 글 줄, 상자 테두리 등이 떨어져 나가지 않게)
    static int[] PickBand(List<int[]> bands, int a, int b, int join)
    {
        int bi = -1, best = 0;
        for (int i = 0; i < bands.Count; i++)
        {
            int ov = Math.Min(b, bands[i][1]) - Math.Max(a, bands[i][0]);
            if (ov > best) { best = ov; bi = i; }
        }
        if (bi < 0) return null;
        int lo = bi, hi = bi;
        // 합치는 건 작은 조각(예상 크기의 20% 이하 — 설명 글 줄·상자 테두리)뿐. 큰 덩어리는 옆 컷이다
        // 그리고 예상 구간 [a,b) 안에 들어 있는 것만 (경계 너머는 옆 컷의 몫)
        int small = (int)((b - a) * 0.2);
        Func<int[], bool> inside = (q) => q[0] >= a - join && q[1] <= b + join;
        while (lo > 0 && bands[lo][0] - bands[lo - 1][1] <= join && bands[lo - 1][1] - bands[lo - 1][0] <= small && inside(bands[lo - 1])) lo--;
        while (hi < bands.Count - 1 && bands[hi + 1][0] - bands[hi][1] <= join && bands[hi + 1][1] - bands[hi + 1][0] <= small && inside(bands[hi + 1])) hi++;
        return new[] { bands[lo][0], bands[hi][1] };
    }

    // 예상 칸 [cx0,cx1)×[ry0,ry1) 을 실제 여백에 맞춰 네 변을 다듬는다. 그림이 거의 없으면 null
    static Int32Rect? Refine(int cx0, int cx1, int ry0, int ry1)
    {
        int cw = cx1 - cx0, ch = ry1 - ry0;
        if (PreserveBounds) return cw > 0 && ch > 0 ? (Int32Rect?)new Int32Rect(cx0, ry0, cw, ch) : null;
        // 가로: 이 줄 높이 안에서 좌우 여백을 찾아, 예상 칸과 가장 많이 겹치는 덩어리를 고른다
        int reach = Math.Max(10, cw / 4);
        int ex0 = Math.Max(0, cx0 - reach), ex1 = Math.Min(W, cx1 + reach);
        var hp = new int[ex1 - ex0];
        for (int y = ry0; y < ry1; y++) { long o = (long)y * W; for (int x = ex0; x < ex1; x++) if (Ink(o + x)) hp[x - ex0]++; }
        var hbs = Bands(ex1 - ex0, i => hp[i] <= Math.Max(1, ch / 50), Math.Max(3, cw / 150));
        int[] hb = PickBand(hbs, cx0 - ex0, cx1 - ex0, 0); // 가로로는 합치지 않는다
        int bx0 = hb == null ? cx0 : hb[0] + ex0, bx1 = hb == null ? cx1 : hb[1] + ex0;
        // 세로: 그 폭 안에서 위아래 여백을 찾는다 (여백에 걸친 설명 글·옆 칸에서 넘어온 조각은 떨어진 덩어리라 빠진다)
        int reachY = Math.Max(10, ch / 4);
        int ey0 = Math.Max(0, ry0 - reachY), ey1 = Math.Min(H, ry1 + reachY), bw = bx1 - bx0;
        var vp = new int[ey1 - ey0];
        for (int y = ey0; y < ey1; y++) { long o = (long)y * W; int n = 0; for (int x = bx0; x < bx1; x++) if (Ink(o + x)) n++; vp[y - ey0] = n; }
        var vbs = Bands(ey1 - ey0, i => vp[i] <= Math.Max(1, bw / 50), Math.Max(3, ch / 150));
        int[] vb = PickBand(vbs, ry0 - ey0, ry1 - ey0, (int)(ch * 0.03));
        int by0 = vb == null ? ry0 : vb[0] + ey0, by1 = vb == null ? ry1 : vb[1] + ey0;
        // 그림 범위로 마무리
        int x0 = bx1, x1 = bx0, y0 = by1, y1 = by0;
        long ink = 0;
        for (int y = by0; y < by1; y++)
        {
            long o = (long)y * W;
            for (int x = bx0; x < bx1; x++) if (Ink(o + x)) { ink++; if (x < x0) x0 = x; if (x >= x1) x1 = x + 1; if (y < y0) y0 = y; if (y >= y1) y1 = y + 1; }
        }
        if (x1 - x0 < Math.Max(MinSize, cw * 0.25) || y1 - y0 < Math.Max(MinSize, ch * 0.25)) return null;
        if (ink < (long)(x1 - x0) * (y1 - y0) * 0.02) return null; // 빈 칸
        return new Int32Rect(x0, y0, x1 - x0, y1 - y0);
    }

    // 격자형: 열을 먼저 나누고, 줄은 전체 폭 기준 균등 골짜기로(안 되면 열마다 가로 여백으로) 나눈 뒤 칸마다 다듬는다
    static List<Int32Rect> ColumnGrid(List<int[]> cols)
    {
        var cells = new List<Int32Rect>();
        var rowInk = new int[H];
        for (int y = 0; y < H; y++) { long o = (long)y * W; int n = 0; for (int x = 0; x < W; x++) if (Ink(o + x)) n++; rowInk[y] = n; }
        var smR = Smooth(rowInk, W);
        var log = new StringBuilder();
        var rcuts = UniformCuts(smR, 2, 12, Median(smR, 0.05, 0.95), log);
        GridRaw += " | rows " + log;
        if (rcuts != null)
        {
            var rows = ToBands(rcuts, H);
            foreach (var r in rows)
                foreach (var c in cols)
                {
                    var cell = Refine(c[0], c[1], r[0], r[1]);
                    if (cell.HasValue) cells.Add(cell.Value);
                }
        }
        else
        {
            GridRaw += "(균등 줄 아님 → 열마다 가로 여백)";
            foreach (var c in cols)
            {
                int cx0 = c[0], cx1 = c[1], cw = cx1 - cx0;
                var ri = new int[H];
                for (int y = 0; y < H; y++) { long o = (long)y * W; int n = 0; for (int x = cx0; x < cx1; x++) if (Ink(o + x)) n++; ri[y] = n; }
                var rows = Bands(H, y => ri[y] <= Math.Max(1, cw / 250), Math.Max(MinGap / 2, Math.Max(4, cw / 100)));
                foreach (var r in rows)
                {
                    if (r[1] - r[0] < cw * 0.3) continue; // 짧은 조각(설명 글·넘어온 조각)
                    var cell = Refine(cx0, cx1, r[0], r[1]);
                    if (cell.HasValue) cells.Add(cell.Value);
                }
            }
        }
        // 겹치는 칸 정리 (같은 컷이 두 번 잡힌 경우 큰 쪽만)
        cells.Sort((a, b) => ((long)b.Width * b.Height).CompareTo((long)a.Width * a.Height));
        var uniq = new List<Int32Rect>();
        foreach (var r in cells)
        {
            bool dup = false;
            foreach (var q in uniq)
            {
                long ix = Math.Max(0, Math.Min(r.X + r.Width, q.X + q.Width) - Math.Max(r.X, q.X));
                long iy = Math.Max(0, Math.Min(r.Y + r.Height, q.Y + q.Height) - Math.Max(r.Y, q.Y));
                if (ix * iy > (long)r.Width * r.Height * 0.6) { dup = true; break; }
            }
            if (!dup) uniq.Add(r);
        }
        // 읽는 순서: 세로로 겹치는 칸끼리 한 줄로 묶고, 줄은 위→아래, 줄 안은 왼→오 (rtl 이면 오→왼)
        uniq.Sort((a, b) => a.Y.CompareTo(b.Y));
        var lines = new List<List<Int32Rect>>();
        foreach (var r in uniq)
        {
            var line = lines.Count > 0 ? lines[lines.Count - 1] : null;
            if (line != null)
            {
                int top = int.MaxValue, bottom = 0;
                foreach (var q in line) { top = Math.Min(top, q.Y); bottom = Math.Max(bottom, q.Y + q.Height); }
                int ov = Math.Min(bottom, r.Y + r.Height) - Math.Max(top, r.Y);
                if (ov >= Math.Min(r.Height, bottom - top) * 0.5) { line.Add(r); continue; }
            }
            lines.Add(new List<Int32Rect> { r });
        }
        var ordered = new List<Int32Rect>();
        foreach (var line in lines)
        {
            line.Sort((a, b) => Rtl ? b.X.CompareTo(a.X) : a.X.CompareTo(b.X));
            ordered.AddRange(line);
        }
        return ordered;
    }

    // 가장 큰 컷이 속한 본문 열만 남긴다 (옆 광고 칸·브라우저 UI 제거)
    static List<Int32Rect> MainColumn(List<Int32Rect> all)
    {
        if (all.Count < 3) return all;
        Int32Rect big = all[0];
        foreach (var r in all) if ((long)r.Width * r.Height > (long)big.Width * big.Height) big = r;
        int c0 = big.X, c1 = big.X + big.Width;
        var keep = new List<Int32Rect>();
        foreach (var r in all)
        {
            int ov = Math.Min(c1, r.X + r.Width) - Math.Max(c0, r.X);
            if (ov <= 0) continue;
            bool inside = ov >= r.Width * 0.8;
            bool spans = ov >= (c1 - c0) * 0.95 && r.Width <= (c1 - c0) * 1.3;
            if (inside || spans) keep.Add(r);
        }
        return keep;
    }
}
