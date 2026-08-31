import os
import time

from openai import OpenAI

from core.config import AI_MODEL


VOICE_SYSTEM_PROMPT = """
РОЛЬ:
Ты — голосовой ассистент для общения с человеком в реальном времени.

ОСНОВНАЯ ЦЕЛЬ:
Давать понятные, короткие и естественные ответы, которые удобно слушать, а не читать.

СТИЛЬ РЕЧИ:
Говори как человек.
Разговорный, спокойный, дружелюбный тон.
Без формального языка и сложных терминов.

ОГРАНИЧЕНИЯ ФОРМАТА:
Отвечай ТОЛЬКО обычным текстом.
НЕ используй markdown.
НЕ используй списки.
НЕ используй код.
НЕ используй символы форматирования (* # - _ `).
НЕ используй эмодзи.

ДЛИНА ОТВЕТА:
Максимум 2–3 коротких предложения.
Если тема сложная — дай краткое объяснение и предложи продолжить.

ПОВЕДЕНИЕ:
Не повторяй вопрос пользователя.
Не добавляй вводные фразы типа "Конечно" или "Вот ответ".
Сразу отвечай по сути.

ЕСЛИ НЕ УВЕРЕН:
Скажи честно и предложи уточнить.

ВАЖНО:
Ты предназначен для озвучивания через TTS.
Ответ должен звучать естественно вслух.
"""


PROXY_ENV_KEYS = (
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "all_proxy",
)


class OpenAIClient:

    def __init__(self, api_key):
        self.api_key = api_key
        self.available = bool(api_key)

        self.max_chars = 600
        self.retry_count = 2

        if self.available:
            # Some VPN/proxy programs publish socks4://127.0.0.1:PORT via
            # environment variables. The OpenAI HTTP stack rejects SOCKS4 at
            # initialization. Temporarily hide only unsupported SOCKS4 values
            # while the client is created, then restore the process env.
            removed = {}
            try:
                for key in PROXY_ENV_KEYS:
                    value = os.environ.get(key)
                    if value and value.lower().startswith("socks4://"):
                        removed[key] = value
                        os.environ.pop(key, None)

                self.openai_client = OpenAI(api_key=api_key)

            except Exception as e:
                print("❌ OpenAI init failed:", e)
                self.available = False

            finally:
                for key, value in removed.items():
                    os.environ[key] = value

    def ask(self, prompt):
        if not self.available:
            return None

        for attempt in range(self.retry_count):
            try:
                response = self.openai_client.responses.create(
                    model=AI_MODEL,
                    instructions=VOICE_SYSTEM_PROMPT,
                    input=prompt,
                )

                text = getattr(response, "output_text", None)
                if not text:
                    return None

                text = text.strip()

                if len(text) > self.max_chars:
                    text = text[: self.max_chars] + "..."

                return text

            except Exception as e:
                print(f"⚠ OpenAI request failed ({attempt + 1}):", e)
                time.sleep(1)

        return None
