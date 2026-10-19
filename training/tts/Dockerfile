FROM pytorch/pytorch:2.2.2-cuda12.1-cudnn8-runtime
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 \
    HF_HUB_DISABLE_TELEMETRY=1 DO_NOT_TRACK=1 MPLBACKEND=Agg \
    OMP_NUM_THREADS=4 TOKENIZERS_PARALLELISM=false
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential git libsndfile1 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && pip check
ARG VITS_REVISION=6f3f51f4d667f5c3eef89484d151ffd39d2c2b89
RUN git clone https://github.com/ylacombe/finetune-hf-vits.git /opt/vits \
    && cd /opt/vits && git checkout "$VITS_REVISION" && rm -rf .git \
    && cd monotonic_align && mkdir -p monotonic_align && python setup.py build_ext --inplace
ENV PYTHONPATH=/opt/vits:/app
COPY provenance.json bootstrap.py ./
RUN python bootstrap.py
# All model downloads happen during the build, before renting a GPU.
ENV HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1
COPY *.py phone-phrases.json ./
RUN python patch_vits.py && python -m unittest discover -s . -p 'test_*.py' -v
ENTRYPOINT ["python", "/app/train.py"]

