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


class GeminiClient:
    """Compatibility name kept so the rest of the original Jarvis stays unchanged."""

    def __init__(self, api_key):
        self.api_key = api_key
        self.available = bool(api_key)

        self.max_chars = 600
        self.retry_count = 2

        if self.available:
            try:
                self.openai_client = OpenAI(api_key=api_key)
            except Exception as e:
                print("❌ OpenAI init failed:", e)
                self.available = False

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
