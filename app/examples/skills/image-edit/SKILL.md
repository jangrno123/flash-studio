---
name: image-edit
description: 첨부 이미지를 직접 보고 수정·보정·변환한다. "이미지 수정해줘", "잘라줘", "여백 없애줘", "16:9로 바꿔줘", "밝게", "크기 줄여줘", "회전", "머리색 바꿔줘", "배경 바꿔줘", "말풍선 지워줘" 같은 요청에 사용. 이미지를 볼 수 있는 모델(DeepSeek V4.1 등)에서 쓴다.
---

# 이미지 편집

## 1. 먼저 이미지를 본다
첨부 이미지에서 인물·사물의 위치, 여백, 비율, 글자나 말풍선 위치를 먼저 파악한다. 여러 장이면 사용자가 말한 이미지가 어느 것인지 이름으로 확인한다.

## 2. 도구 고르기

| 요청 | 도구 |
|---|---|
| 자르기, 여백 제거, 특정 부분만 남기기 | `edit_image` → `crop` (좌표는 이미지 대비 % 로 어림잡는다) |
| 크기 변경 | `edit_image` → `resize` |
| 회전, 좌우·상하 반전 | `edit_image` → `rotate` / `flip` |
| 비율만 맞추기 (남는 곳은 단색 여백) | `edit_image` → `pad` |
| 밝기·대비·채도 | `edit_image` → `adjust` |
| 내용 변경: 머리색·옷·배경 바꾸기, 말풍선·글자 지우기, 16:9로 장면 이어 그리기, 화풍 변환 | `generate_image` + `reference_images` |
| 웹툰 컷 나누기 | `crop_panels` |

픽셀만 손보면 되는 요청에 `generate_image` 를 쓰지 않는다. 원본 그림이 다시 그려지고 비용도 든다.

## 3. generate_image 로 수정할 때
- `reference_images` 에 수정할 이미지 하나만 넣는다 (첨부 파일 이름이나 `/files/...` 경로).
- 무엇을 유지하고 무엇만 바꾸는지 분명히 쓴다.

```
Edit the reference image. Change only: {바꿀 내용}.
Keep everything else identical: same characters, faces, hairstyles, outfits, pose, composition, camera angle, lighting, colors and art style.
```

16:9로 넓힐 때:

```
Extend the reference image to a 16:9 widescreen frame by continuing the scene naturally on the left and right.
Keep the original content, characters and art style unchanged. No borders, no letterboxing, no added text.
```

## 4. 결과 확인
- 도구가 만든 이미지는 다음 차례에 자동으로 다시 보인다. 요청과 비교한다: 잘린 위치, 남은 여백, 바뀌면 안 되는 부분이 바뀌지 않았는지.
- `edit_image` 결과가 어긋나면 좌표나 값을 고쳐 한 번 더 실행한다 (무료).
- `generate_image` 결과가 어긋나면 어디가 틀렸는지 말하고, 다시 만들지 사용자에게 묻는다 (비용이 든다).
- 여러 단계로 편집할 때는 앞 단계 결과 경로(`/files/images/...`)를 다음 단계의 `image` 로 넘긴다.

## 5. 보고
결과 이미지 경로와 크기, 무엇을 했는지만 한두 줄로 알린다.
