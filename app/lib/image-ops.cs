// 로컬 이미지 편집: 자르기, 크기 조정, 회전, 반전, 비율 맞춰 여백 채우기, 밝기·대비·채도
using System;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

public static class ImageOps
{
    public static BitmapSource Load(string path)
    {
        var dec = BitmapDecoder.Create(new Uri(path), BitmapCreateOptions.IgnoreColorProfile, BitmapCacheOption.OnLoad);
        BitmapSource s = dec.Frames[0];
        if (s.Format != PixelFormats.Bgra32) s = new FormatConvertedBitmap(s, PixelFormats.Bgra32, null, 0);
        s.Freeze();
        return s;
    }

    public static BitmapSource Crop(BitmapSource s, int x, int y, int w, int h)
    {
        x = Clamp(x, 0, s.PixelWidth - 1); y = Clamp(y, 0, s.PixelHeight - 1);
        w = Clamp(w, 1, s.PixelWidth - x); h = Clamp(h, 1, s.PixelHeight - y);
        var c = new CroppedBitmap(s, new Int32Rect(x, y, w, h));
        c.Freeze();
        return ToBgra(c);
    }

    // 고품질 크기 조정
    public static BitmapSource Resize(BitmapSource s, int w, int h)
    {
        w = Math.Max(1, w); h = Math.Max(1, h);
        var dv = new DrawingVisual();
        RenderOptions.SetBitmapScalingMode(dv, BitmapScalingMode.HighQuality);
        using (var dc = dv.RenderOpen()) dc.DrawImage(s, new Rect(0, 0, w, h));
        var rtb = new RenderTargetBitmap(w, h, 96, 96, PixelFormats.Pbgra32);
        rtb.Render(dv);
        return ToBgra(rtb);
    }

    public static BitmapSource Rotate(BitmapSource s, int degrees)
    {
        int d = ((degrees % 360) + 360) % 360;
        if (d == 0) return s;
        var t = new TransformedBitmap(s, new RotateTransform(d));
        return ToBgra(t);
    }

    public static BitmapSource Flip(BitmapSource s, bool horizontal)
    {
        var t = new TransformedBitmap(s, new ScaleTransform(horizontal ? -1 : 1, horizontal ? 1 : -1));
        return ToBgra(t);
    }

    // 캔버스를 w×h 로 넓히고 가운데에 원본을 둔다 (나머지는 단색)
    public static BitmapSource Pad(BitmapSource s, int w, int h, byte r, byte g, byte b)
    {
        w = Math.Max(w, s.PixelWidth); h = Math.Max(h, s.PixelHeight);
        var dst = new byte[w * h * 4];
        for (int i = 0; i < dst.Length; i += 4) { dst[i] = b; dst[i + 1] = g; dst[i + 2] = r; dst[i + 3] = 255; }
        int sw = s.PixelWidth, sh = s.PixelHeight;
        var src = new byte[sw * sh * 4];
        s.CopyPixels(src, sw * 4, 0);
        int ox = (w - sw) / 2, oy = (h - sh) / 2;
        for (int y = 0; y < sh; y++) Buffer.BlockCopy(src, y * sw * 4, dst, ((y + oy) * w + ox) * 4, sw * 4);
        var bmp = BitmapSource.Create(w, h, 96, 96, PixelFormats.Bgra32, null, dst, w * 4);
        bmp.Freeze();
        return bmp;
    }

    // brightness: -100~100, contrast: -100~100, saturation: -100~100 (0 이면 변화 없음)
    public static BitmapSource Adjust(BitmapSource s, double brightness, double contrast, double saturation)
    {
        int w = s.PixelWidth, h = s.PixelHeight;
        var px = new byte[w * h * 4];
        s.CopyPixels(px, w * 4, 0);
        double bOff = brightness * 2.55;
        double cF = (100 + contrast) / 100.0; cF *= cF;
        double sF = (100 + saturation) / 100.0;
        for (int i = 0; i < px.Length; i += 4)
        {
            double B = px[i], G = px[i + 1], R = px[i + 2];
            double lum = 0.299 * R + 0.587 * G + 0.114 * B;
            R = lum + (R - lum) * sF; G = lum + (G - lum) * sF; B = lum + (B - lum) * sF;
            R = (R - 128) * cF + 128 + bOff; G = (G - 128) * cF + 128 + bOff; B = (B - 128) * cF + 128 + bOff;
            px[i] = Byte(B); px[i + 1] = Byte(G); px[i + 2] = Byte(R);
        }
        var bmp = BitmapSource.Create(w, h, 96, 96, PixelFormats.Bgra32, null, px, w * 4);
        bmp.Freeze();
        return bmp;
    }

    public static void Save(BitmapSource s, string path, int jpegQuality)
    {
        BitmapEncoder enc;
        if (path.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase))
        {
            // JPG 는 알파가 없으므로 흰 배경에 합성
            enc = new JpegBitmapEncoder { QualityLevel = Clamp(jpegQuality, 1, 100) };
            s = new FormatConvertedBitmap(s, PixelFormats.Bgr32, null, 0);
        }
        else enc = new PngBitmapEncoder();
        enc.Frames.Add(BitmapFrame.Create(s));
        using (var fs = File.Create(path)) enc.Save(fs);
    }

    static BitmapSource ToBgra(BitmapSource s)
    {
        var f = new FormatConvertedBitmap(s, PixelFormats.Bgra32, null, 0);
        int w = f.PixelWidth, h = f.PixelHeight;
        var px = new byte[w * h * 4];
        f.CopyPixels(px, w * 4, 0);
        var bmp = BitmapSource.Create(w, h, 96, 96, PixelFormats.Bgra32, null, px, w * 4);
        bmp.Freeze();
        return bmp;
    }

    static int Clamp(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }
    static byte Byte(double v) { return (byte)(v < 0 ? 0 : v > 255 ? 255 : v + 0.5); }
}
