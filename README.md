# Shariah AI Compliance Platform Backend

Минимальный backend для MVP личного кабинета Shariah AI Compliance Platform.

## Что делает

- Принимает файл через `POST /api/check-document`
- Поддерживает `.txt`, `.pdf`, `.docx`
- Извлекает текст из файла
- Отправляет текст в OpenAI API
- Возвращает структурированный JSON-отчет
- Работает без базы данных и авторизации на первом этапе

## Установка

```bash
npm install
```

## Настройка

Создайте файл `.env`:

```bash
cp .env.example .env
```

Вставьте свой OpenAI API key:

```env
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-5.2
PORT=3000
```

## Запуск

```bash
npm run dev
```

Сервер будет доступен:

```text
http://localhost:3000
```

## Проверка

```bash
curl http://localhost:3000/health
```

## Endpoint

```text
POST /api/check-document
```

`multipart/form-data` поля:

- `file` — файл .txt, .pdf или .docx
- `checkType` — тип проверки
- `checkName` — название проверки
- `comment` — комментарий

## Пример curl

```bash
curl -X POST http://localhost:3000/api/check-document \
  -F "file=@./example.pdf" \
  -F "checkType=Договор Murabaha" \
  -F "checkName=Murabaha Agreement Test" \
  -F "comment=Проверить комиссии, отсрочку платежа и ответственность сторон"
```
