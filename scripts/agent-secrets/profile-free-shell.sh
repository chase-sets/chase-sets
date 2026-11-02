#!/bin/sh
if [ "$#" -ne 2 ] || [ "$1" != "-c" ]; then
  exit 64
fi
exec '__POWERSHELL_PATH__' -NoProfile -NonInteractive -Command "$2"
