import argparse
import asyncio
import importlib
import json
import os
import shutil
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

import websockets
from websockets.exceptions import ConnectionClosed


@dataclass
class EngineConfig:
    model_size: str = os.environ.get("VOSK_MODEL_SIZE", "small").strip().lower()
    model_path: str = os.environ.get(
        "VOSK_MODEL_PATH",
        "",
    )
    sample_rate: float = float(os.environ.get("VOSK_SAMPLE_RATE", "16000"))


MODEL_SPECS = {
    "small": {
        "dir": "vosk-model-small-en-us-0.15",
        "url": "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip",
    },
    "medium": {
        "dir": "vosk-model-en-us-0.22",
        "url": "https://alphacephei.com/vosk/models/vosk-model-en-us-0.22.zip",
    },
    "large": {
        "dir": "vosk-model-en-us-0.42-gigaspeech",
        "url": "https://alphacephei.com/vosk/models/vosk-model-en-us-0.42-gigaspeech.zip",
    },
}


class VoskTranscriber:
    def __init__(self, cfg: EngineConfig):
        self.cfg = cfg
        self.model = None
        self.load_lock = asyncio.Lock()
        self.load_error = ""
        self.status_message = "model-not-loaded"

    def _selected_model_spec(self):
        size = self.cfg.model_size if self.cfg.model_size in MODEL_SPECS else "small"
        self.cfg.model_size = size
        return MODEL_SPECS[size]

    def _resolve_model_dir(self) -> Path:
        explicit = str(self.cfg.model_path or "").strip()
        if explicit:
            return Path(explicit)
        spec = self._selected_model_spec()
        return Path(__file__).resolve().parent / "models" / spec["dir"]

    def _download_model_if_missing(self, model_dir: Path):
        if model_dir.exists():
            return

        spec = self._selected_model_spec()
        url = spec["url"]
        model_dir.parent.mkdir(parents=True, exist_ok=True)
        self.status_message = f"downloading-vosk-model:{self.cfg.model_size}"
        print(f"[startup] downloading-vosk-model size={self.cfg.model_size} url={url}", flush=True)

        with tempfile.TemporaryDirectory(prefix="vosk-model-") as tmp_dir:
            visible_download_path = model_dir.parent / f"{spec['dir']}.zip.part"
            with urllib.request.urlopen(url) as response, open(visible_download_path, "wb") as out_file:
                total_bytes = int(response.headers.get("Content-Length", "0") or 0)
                downloaded = 0
                next_emit_percent = 0
                next_emit_bytes = 0

                if total_bytes > 0:
                    print(
                        f"[startup] downloading-vosk-model-total size={self.cfg.model_size} bytes={total_bytes}",
                        flush=True,
                    )

                print(
                    f"[startup] downloading-vosk-model-file size={self.cfg.model_size} path={visible_download_path}",
                    flush=True,
                )

                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    out_file.write(chunk)
                    downloaded += len(chunk)

                    while downloaded >= next_emit_bytes:
                        self.status_message = (
                            f"downloading-vosk-model-bytes:{self.cfg.model_size}:{downloaded}"
                        )
                        print(
                            f"[startup] downloading-vosk-model-bytes size={self.cfg.model_size} bytes={downloaded}",
                            flush=True,
                        )
                        next_emit_bytes += 1 * 1024 * 1024

                    if total_bytes > 0:
                        percent = int((downloaded * 100) / total_bytes)
                        while percent >= next_emit_percent and next_emit_percent <= 100:
                            self.status_message = (
                                f"downloading-vosk-model-progress:{self.cfg.model_size}:{next_emit_percent}"
                            )
                            print(
                                f"[startup] downloading-vosk-model-progress size={self.cfg.model_size} percent={next_emit_percent} bytes={downloaded} total={total_bytes}",
                                flush=True,
                            )
                            next_emit_percent += 1

                if total_bytes > 0 and next_emit_percent <= 100:
                    self.status_message = f"downloading-vosk-model-progress:{self.cfg.model_size}:100"
                    print(
                        f"[startup] downloading-vosk-model-progress size={self.cfg.model_size} percent=100 bytes={downloaded} total={total_bytes}",
                        flush=True,
                    )
                elif total_bytes <= 0:
                    self.status_message = (
                        f"downloading-vosk-model-bytes:{self.cfg.model_size}:{downloaded}"
                    )
                    print(
                        f"[startup] downloading-vosk-model-bytes size={self.cfg.model_size} bytes={downloaded}",
                        flush=True,
                    )

            extract_root = Path(tmp_dir) / "extract"
            extract_root.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(visible_download_path, "r") as zf:
                zf.extractall(str(extract_root))

            extracted_target = None
            preferred = extract_root / spec["dir"]
            if preferred.exists():
                extracted_target = preferred
            else:
                for child in extract_root.iterdir():
                    if child.is_dir() and child.name.startswith("vosk-model"):
                        extracted_target = child
                        break

            if extracted_target is None:
                raise RuntimeError(f"Downloaded archive did not contain a Vosk model folder: {url}")

            if model_dir.exists():
                shutil.rmtree(model_dir)
            shutil.move(str(extracted_target), str(model_dir))

            try:
                visible_download_path.unlink(missing_ok=True)
            except Exception:
                pass

        print(f"[startup] downloaded-vosk-model size={self.cfg.model_size} path={model_dir}", flush=True)

    async def load(self):
        async with self.load_lock:
            if self.model is not None:
                return
            if self.load_error:
                raise RuntimeError(self.load_error)

            self.status_message = "loading-vosk-model"
            loop = asyncio.get_running_loop()
            try:
                await loop.run_in_executor(None, self._load_blocking)
                self.status_message = "model-ready"
            except Exception as exc:
                self.load_error = str(exc)
                self.status_message = f"model-load-failed: {self.load_error}"
                raise

    def _load_blocking(self):
        try:
            vosk = importlib.import_module("vosk")
            Model = getattr(vosk, "Model")
            SetLogLevel = getattr(vosk, "SetLogLevel")
        except Exception as exc:
            raise RuntimeError(
                "Vosk is not installed. Install with: pip install vosk"
            ) from exc

        model_dir = self._resolve_model_dir()
        self._download_model_if_missing(model_dir)
        if not model_dir.exists():
            raise RuntimeError(f"Vosk model not found after download attempt: '{model_dir}'")

        SetLogLevel(-1)
        self.model = Model(str(model_dir))

    def create_recognizer(self, word_list=None):
        if self.model is None:
            raise RuntimeError("model-not-loaded")

        vosk = importlib.import_module("vosk")
        KaldiRecognizer = getattr(vosk, "KaldiRecognizer")

        if word_list and isinstance(word_list, list):
            # Constrain recognition to Bible book names + number words so the acoustic model
            # prefers e.g. "malachi" over "maliki" or "male cats", "exodus" over "x oh x".
            # "[unk]" is always included so anything outside the list still passes through.
            words = list(word_list)
            if "[unk]" not in words:
                words.insert(0, "[unk]")
            recognizer = KaldiRecognizer(self.model, self.cfg.sample_rate, json.dumps(words))
        else:
            recognizer = KaldiRecognizer(self.model, self.cfg.sample_rate)
        recognizer.SetWords(True)
        return recognizer


async def safe_send(ws, payload: dict) -> bool:
    try:
        await ws.send(json.dumps(payload))
        return True
    except ConnectionClosed:
        return False


async def handle_connection(ws, transcriber: VoskTranscriber):
    recognizer = None

    if not await safe_send(ws, {"type": "status", "message": "sidecar-connected"}):
        return
    if not await safe_send(ws, {"type": "status", "message": transcriber.status_message}):
        return
    if transcriber.load_error:
        if not await safe_send(ws, {"type": "status", "message": f"error: {transcriber.load_error}"}):
            return

    try:
        async for message in ws:
            if isinstance(message, bytes):
                if recognizer is None:
                    continue

                try:
                    accepted = recognizer.AcceptWaveform(message)
                    if accepted:
                        result = json.loads(recognizer.Result() or "{}")
                        text = str(result.get("text", "")).strip()
                        if text:
                            if not await safe_send(ws, {"type": "final", "text": text}):
                                return
                    else:
                        result = json.loads(recognizer.PartialResult() or "{}")
                        partial = str(result.get("partial", "")).strip()
                        if partial:
                            if not await safe_send(ws, {"type": "partial", "text": partial}):
                                return
                except Exception as exc:
                    if not await safe_send(ws, {"type": "status", "message": f"warn: vosk-process: {exc}"}):
                        return
                continue

            try:
                payload = json.loads(message)
            except Exception:
                continue

            msg_type = payload.get("type")
            if msg_type == "start":
                if transcriber.model is None and not transcriber.load_error:
                    if not await safe_send(ws, {"type": "status", "message": "loading-vosk-model"}):
                        return
                    try:
                        await transcriber.load()
                        if not await safe_send(ws, {"type": "status", "message": "model-ready"}):
                            return
                    except Exception as exc:
                        if not await safe_send(ws, {"type": "status", "message": f"error: {exc}"}):
                            return
                        continue

                word_list = payload.get("wordList")
                if transcriber.model is not None:
                    try:
                        recognizer = transcriber.create_recognizer(word_list=word_list)
                    except Exception as exc:
                        if not await safe_send(ws, {"type": "status", "message": f"error: {exc}"}):
                            return
                        continue

                if not await safe_send(ws, {"type": "status", "message": "transcription-started"}):
                    return

            elif msg_type == "stop":
                if recognizer is not None:
                    try:
                        result = json.loads(recognizer.FinalResult() or "{}")
                        text = str(result.get("text", "")).strip()
                        if text:
                            if not await safe_send(ws, {"type": "final", "text": text}):
                                return
                    except Exception as exc:
                        if not await safe_send(ws, {"type": "status", "message": f"warn: vosk-final: {exc}"}):
                            return

                recognizer = None
                if not await safe_send(ws, {"type": "status", "message": "transcription-stopped"}):
                    return
    except ConnectionClosed:
        return


async def main(host: str, port: int):
    cfg = EngineConfig()
    transcriber = VoskTranscriber(cfg)

    print("[startup] initializing sidecar...", flush=True)
    preload_task = asyncio.create_task(transcriber.load())

    print(
        f"[startup] ready model=vosk/{cfg.model_size} backend=vosk sample_rate={int(cfg.sample_rate)}",
        flush=True,
    )

    async with websockets.serve(
        lambda ws: handle_connection(ws, transcriber),
        host,
        port,
        max_size=2**24,
        ping_interval=30,
        ping_timeout=None,
    ):
        print(f"[startup] listening ws://{host}:{port}/transcribe", flush=True)

        def _on_preload_done(task: asyncio.Task):
            try:
                task.result()
                print("[startup] Vosk model loaded.", flush=True)
            except Exception as exc:
                print(f"[startup] Vosk preload failed: {exc}", flush=True)

        preload_task.add_done_callback(_on_preload_done)
        await asyncio.Future()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    asyncio.run(main(args.host, args.port))
