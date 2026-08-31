import sounddevice as sd
import queue
import json
import time
import os
import sys
import numpy as np

from vosk import Model, KaldiRecognizer

try:
    import openwakeword
    from openwakeword.model import Model as OpenWakeWordModel
except Exception:
    openwakeword = None
    OpenWakeWordModel = None


# AUDIO QUEUE
q = queue.Queue(maxsize=120)


# GLOBAL MIC STATS
noise_floor = 10.0  # initial guess
alpha = 0.05  # smoothing factor (LOW = STABLE)


def callback(indata, frames, time_info, status):

    global noise_floor

    # RMS loudness
    volume = np.linalg.norm(indata) * 10

    # Adaptive noise calibration (EMA smoothing)
    noise_floor = (1 - alpha) * noise_floor + alpha * volume

    # Push audio frame + current volume
    if not q.full():
        q.put((bytes(indata), volume))


def resource_path(relative):

    if hasattr(sys, "_MEIPASS"):
        return os.path.join(sys._MEIPASS, relative)

    return relative


# STT CLASS
class SpeachToText:

    def __init__(self, model_path):

        self.model = Model(resource_path(model_path))
        self.recognizer = KaldiRecognizer(self.model, 16000)

        self.stream = None
        self.active = False

        # openWakeWord replaces Picovoice Porcupine.
        # Load the exact bundled ONNX path. This makes it possible to replace
        # only hey_jarvis_v0.1.onnx with a custom compatible Jarvis model.
        self.wakeword_model = None
        self.wakeword_model_path = None
        if OpenWakeWordModel is not None and openwakeword is not None:
            try:
                bundled = openwakeword.MODELS["hey_jarvis"]["model_path"]
                model_file = bundled.replace(".tflite", ".onnx")
                self.wakeword_model_path = model_file

                self.wakeword_model = OpenWakeWordModel(
                    wakeword_models=[model_file],
                    inference_framework="onnx",
                )

                size = os.path.getsize(model_file) if os.path.exists(model_file) else -1
                print(f"openWakeWord model loaded: {model_file} ({size} bytes)")
            except Exception as e:
                print("openWakeWord init error:", e)

    @property
    def wakeword_available(self):
        return self.wakeword_model is not None

    # START MIC
    def start(self):

        if self.active:
            return

        # openWakeWord is designed around 80 ms / 1280 sample frames at 16 kHz.
        # Vosk also accepts these smaller PCM chunks, so one stream can safely
        # feed both wake-word detection and command recognition.
        self.stream = sd.RawInputStream(
            samplerate=16000,
            blocksize=1280,
            dtype="int16",
            channels=1,
            callback=callback,
        )

        self.stream.start()
        self.active = True

    # STOP MIC
    def stop(self):

        if not self.active:
            return

        self.stream.stop()
        self.stream.close()

        self.stream = None
        self.active = False

    # OPENWAKEWORD LISTENER
    def wait_for_wakeword(self, timeout=2, threshold=0.40):
        """Wait for the Jarvis wake phrase using openWakeWord."""

        if self.wakeword_model is None:
            return False

        self.start()
        start_time = time.time()

        while True:
            if time.time() - start_time > timeout:
                return False

            if not q.empty():
                data, _volume = q.get()
                audio = np.frombuffer(data, dtype=np.int16)

                try:
                    prediction = self.wakeword_model.predict(audio)
                    score = max(prediction.values()) if prediction else 0.0

                    if score >= threshold:
                        print(f"openWakeWord detected Jarvis: {score:.3f}")
                        self.wakeword_model.reset()
                        return True
                except Exception as e:
                    print("openWakeWord prediction error:", e)
                    return False

            time.sleep(0.005)

    # SMART LISTEN (ADAPTIVE)
    def listen(self, timeout=10, silence_timeout=1.2):

        global noise_floor

        self.start()

        print("🎤 Listening...")

        start_time = time.time()
        last_voice_time = time.time()

        while True:

            # absolute safety timeout
            if time.time() - start_time > timeout:
                return None

            if not q.empty():

                data, volume = q.get()

                # Dynamic voice threshold
                voice_threshold = max(15, noise_floor * 2.5)

                # Voice detected
                if volume > voice_threshold:
                    last_voice_time = time.time()

                # Vosk recognition
                if self.recognizer.AcceptWaveform(data):

                    result = json.loads(self.recognizer.Result())
                    self.recognizer.Reset()

                    text = result.get("text", "")

                    if text.strip():
                        return text

            # Silence end detection
            if time.time() - last_voice_time > silence_timeout:
                return None
