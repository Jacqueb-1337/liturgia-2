import asyncio
import json
import numpy as np
import websockets


async def main():
    uri = "ws://127.0.0.1:8765/transcribe"
    async with websockets.connect(uri, max_size=2**24) as ws:
        await ws.send(json.dumps({"type": "start"}))

        sr = 16000
        t = np.linspace(0, 2, sr * 2, endpoint=False)
        signal = (0.15 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
        pcm = (np.clip(signal, -1, 1) * 32767).astype(np.int16).tobytes()

        chunk_size = 3200
        for i in range(0, len(pcm), chunk_size):
            await ws.send(pcm[i:i + chunk_size])
            await asyncio.sleep(0.03)

        await asyncio.sleep(6)
        await ws.send(json.dumps({"type": "stop"}))

        end_at = asyncio.get_event_loop().time() + 6
        while asyncio.get_event_loop().time() < end_at:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=1.0)
                print(msg)
            except Exception:
                pass


if __name__ == "__main__":
    asyncio.run(main())
