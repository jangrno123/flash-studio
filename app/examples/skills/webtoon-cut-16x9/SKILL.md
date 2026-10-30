---
name: webtoon-cut-16x9
description: 웹툰·만화 이미지를 컷별로 자르고, 각 컷을 말풍선 없는 16:9 이미지로 바꾼다. "컷별로 잘라줘", "컷 크롭", "웹툰을 16:9로", "말풍선 지워줘", "와이드로 바꿔줘" 같은 요청에 사용.
---

# 웹툰 컷 → 16:9 변환

## 작업 순서
1. `crop_panels` 로 첨부 이미지를 자른다. 세로 스크롤 웹툰이면 `mode: "vertical"`, 출판 만화 한 페이지면 `mode: "grid"`, 모르겠으면 생략한다.
2. 결과를 짧게 알린다. 컷 개수와 번호만 말하고, 잘못 잘린 컷이 있으면 번호를 알려 달라고 한 줄 붙인다.
3. 16:9 변환은 컷마다 이미지 생성 비용이 든다. 변환할 컷 수와 예상 비용을 먼저 알리고 사용자가 확인하면 진행한다.
   - Seedream 5.0 Pro: 장당 약 $0.045 (2048×1152 기준)
   - 사용자가 처음부터 "전부 바로 변환해"라고 했다면 확인 없이 진행한다.
4. 컷마다 `generate_image` 를 한 번씩 호출한다.
   - `reference_images` 에 그 컷의 경로 하나만 넣는다 (예: `["/files/images/cut_..._03.png"]`).
   - `size` 는 넣지 않는다. 설정의 16:9 기본 크기가 쓰인다.
5. 다 끝나면 "컷 3 → 완료"처럼 짧게 정리한다. 실패한 컷이 있으면 이유와 함께 따로 적는다.

## 변환 프롬프트 (영문, 컷마다 이 틀을 그대로 쓴다)

```
Recreate the reference webtoon panel as a single 16:9 widescreen illustration.
Keep exactly the same characters, faces, hairstyles, outfits, poses, camera angle, art style, line art and coloring.
Remove every speech bubble, caption box, sound-effect lettering and all text, and repaint the covered areas so they blend naturally with the surrounding scene.
Extend the scene naturally to the left and right to fill the 16:9 frame. No borders, no letterboxing, no white margins, no new characters.
```

사용자가 컷 내용을 설명해 줬다면 마지막 줄에 `Scene: ...` 한 줄을 덧붙인다.

## 주의
- 이 모델은 이미지를 직접 볼 수 없다. 장면을 지어내서 묘사하지 말고, 모르면 `Scene:` 줄을 빼고 참조 이미지에 맡긴다.
- 컷 하나에 이미지 하나. 여러 컷을 한 장에 합치지 않는다.
- 이전 요청에서 했던 수정(머리색 등)을 사용자가 다시 말하지 않았다면 섞지 않는다.
- 컷이 너무 적게 나뉘면 `min_gap` 을 8 정도로 줄여 다시 자르고, 너무 잘게 나뉘면 30 정도로 늘린다.
