#!/usr/bin/env bash
# 시험 게임 씬을 만들고 윈도우 플레이어를 빌드한다. UNITY 환경변수로 에디터 경로를 바꿀 수 있다.
set -e
cd "$(dirname "$0")"
UNITY="${UNITY:-/c/Program Files/Unity/Hub/Editor/6000.3.20f1/Editor/Unity.exe}"
"$UNITY" -batchmode -quit -projectPath "$(cygpath -w "$PWD/TestGame")" -executeMethod BuildTestGame.Build -logFile "$(cygpath -w "$PWD/build.log")" || true
grep -E "error CS|\[build\] result" build.log
grep -q "\[build\] result Succeeded" build.log
