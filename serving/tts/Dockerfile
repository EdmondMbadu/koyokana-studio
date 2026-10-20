FROM python:3.11-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=2 MKL_NUM_THREADS=2
WORKDIR /app
RUN apt-get update && apt-get install --no-install-recommends -y libsndfile1 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir torch==2.2.2+cpu --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./
COPY model ./model
RUN python -m unittest discover -p 'test_*.py' -v && python smoke_test.py
RUN useradd --create-home --user-group koyokana && chown -R koyokana:koyokana /app
USER koyokana
EXPOSE 8080
CMD ["sh", "-c", "exec gunicorn --bind 0.0.0.0:${PORT:-8080} --workers 1 --threads 2 --timeout 55 --access-logfile /dev/null wsgi:application"]
