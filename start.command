#!/bin/zsh
cd "$(dirname "$0")"
echo "Đang khởi động UNI Sheet -> Drive Sync Tool tại http://localhost:4000 ..."
open "http://localhost:4000" &
node server.js
