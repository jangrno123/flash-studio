@echo off
chcp 65001 >nul
echo Flash Studio 바로가기를 제거합니다. (D:\FlashStudio 폴더와 대화 데이터는 그대로 남습니다)
powershell -NoProfile -Command "$d=[Environment]::GetFolderPath('Desktop'); $p=[Environment]::GetFolderPath('Programs'); Remove-Item -ErrorAction SilentlyContinue (Join-Path $d 'Flash Studio.lnk'), (Join-Path $p 'Flash Studio.lnk'); Write-Host '완료'"
pause
