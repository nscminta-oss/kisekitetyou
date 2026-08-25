@echo off
cd /d "%~dp0"
echo Installing libraries...
pip install -r requirements.txt
echo Starting server... http://127.0.0.1:8000/docs
uvicorn main:app --reload
pause
