import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import OpenAI from "openai";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import path from "path";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const MAX_TEXT_CHARS = 60000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE
  }
});

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

function getFileExtension(filename) {
  return path.extname(filename || "").toLowerCase();
}

async function extractTextFromFile(file) {
  if (!file) {
    throw new Error("Файл не был загружен.");
  }

  const extension = getFileExtension(file.originalname);

  if (extension === ".txt") {
    return file.buffer.toString("utf8");
  }

  if (extension === ".pdf") {
    const result = await pdfParse(file.buffer);
    return result.text || "";
  }

  if (extension === ".docx") {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value || "";
  }

  throw new Error("Неподдерживаемый формат файла. Разрешены: .txt, .pdf, .docx");
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateText(text) {
  if (text.length <= MAX_TEXT_CHARS) {
    return {
      text,
      wasTruncated: false
    };
  }

  return {
    text: text.slice(0, MAX_TEXT_CHARS),
    wasTruncated: true
  };
}

function safeJsonParse(rawText) {
  if (!rawText) {
    throw new Error("AI вернул пустой ответ.");
  }

  try {
    return JSON.parse(rawText);
  } catch (error) {
    const cleaned = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    return JSON.parse(cleaned);
  }
}

const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    overallStatus: {
      type: "string",
      description: "Общий статус проверки"
    },
    riskLevel: {
      type: "string",
      enum: ["Низкий", "Средний", "Высокий"],
      description: "Уровень риска"
    },
    complianceScore: {
      type: "number",
      minimum: 0,
      maximum: 100,
      description: "Оценка соответствия от 0 до 100"
    },
    issuesFound: {
      type: "number",
      minimum: 0,
      description: "Количество найденных замечаний"
    },
    recommendation: {
      type: "string",
      description: "Рекомендация для compliance-команды"
    },
    aiSummary: {
      type: "string",
      description: "Краткий вывод AI"
    },
    findings: {
      type: "array",
      description: "Найденные замечания",
      items: {
        type: "string"
      }
    },
    nextSteps: {
      type: "array",
      description: "Следующие действия",
      items: {
        type: "string"
      }
    }
  },
  required: [
    "overallStatus",
    "riskLevel",
    "complianceScore",
    "issuesFound",
    "recommendation",
    "aiSummary",
    "findings",
    "nextSteps"
  ]
};

const systemPrompt = `
Ты — AI Shariah Compliance Analyst для исламского банка.

Твоя задача — проанализировать документ или описание сделки на предмет потенциальных рисков Shariah Compliance.

Важно:
Ты не выдаешь финальную фетву.
Ты не заменяешь Shariah Board.
Ты помогаешь compliance-команде быстро найти потенциальные проблемы, спорные пункты и зоны, которые требуют проверки специалистом.

Проверь документ по следующим направлениям:
1. Возможные элементы riba / interest
2. Gharar / excessive uncertainty
3. Maysir / gambling-like risk
4. Неясные комиссии
5. Условия отсрочки платежа
6. Ответственность сторон
7. Соответствие структуре Murabaha / Ijarah / Sukuk, если применимо
8. Наличие ссылок на внутреннюю Shariah policy
9. Пункты, которые должен проверить Shariah Officer

Если текст документа слишком короткий, неполный или непонятный:
- поставь riskLevel: "Средний"
- укажи, что данных недостаточно для уверенной проверки
- предложи загрузить полный документ или добавить внутреннюю политику банка

Отвечай только на русском языке.
Верни строго JSON по заданной схеме.
`;

async function analyzeWithOpenAI({ extractedText, checkType, checkName, comment, wasTruncated }) {
  if (!openai) {
    const error = new Error("OPENAI_API_KEY отсутствует. Добавьте ключ в .env файл.");
    error.statusCode = 500;
    throw error;
  }

  const userPrompt = `
Тип проверки: ${checkType || "Не указан"}
Название проверки: ${checkName || "Не указано"}
Комментарий сотрудника банка: ${comment || "Нет комментария"}

Документ был обрезан из-за ограничения размера текста: ${wasTruncated ? "Да" : "Нет"}

Текст документа:
"""
${extractedText}
"""
`;

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    instructions: systemPrompt,
    input: userPrompt,
    text: {
      format: {
        type: "json_schema",
        name: "shariah_compliance_report",
        schema: responseSchema,
        strict: true
      }
    }
  });

  const rawText = response.output_text;
  return safeJsonParse(rawText);
}

app.get("/", (req, res) => {
  res.json({
    service: "Shariah AI Compliance Platform Backend",
    status: "ok",
    endpoints: {
      health: "GET /health",
      checkDocument: "POST /api/check-document"
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    openaiKeyConfigured: Boolean(OPENAI_API_KEY),
    model: OPENAI_MODEL
  });
});

app.post("/api/check-document", upload.single("file"), async (req, res, next) => {
  try {
    const { checkType, checkName, comment } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Файл обязателен. Передайте файл в поле file."
      });
    }

    const extension = getFileExtension(req.file.originalname);
    const allowedExtensions = [".txt", ".pdf", ".docx"];

    if (!allowedExtensions.includes(extension)) {
      return res.status(400).json({
        success: false,
        error: "Неподдерживаемый формат файла. Разрешены: .txt, .pdf, .docx"
      });
    }

    const rawText = await extractTextFromFile(req.file);
    const normalizedText = normalizeText(rawText);

    if (!normalizedText || normalizedText.length < 50) {
      return res.json({
        success: true,
        meta: {
          filename: req.file.originalname,
          fileSize: req.file.size,
          checkType: checkType || null,
          checkName: checkName || null,
          extractedTextLength: normalizedText.length,
          warning: "Текст документа слишком короткий для уверенной проверки."
        },
        report: {
          overallStatus: "Требует проверки специалистом",
          riskLevel: "Средний",
          complianceScore: 50,
          issuesFound: 1,
          recommendation: "Загрузить полный документ и передать Shariah Officer для финального подтверждения",
          aiSummary: "Из документа извлечено слишком мало текста. Данных недостаточно для уверенной Shariah Compliance проверки.",
          findings: [
            "Недостаточно текста для анализа возможных элементов riba, gharar, maysir и условий сделки."
          ],
          nextSteps: [
            "Проверить качество загруженного файла.",
            "Загрузить полный документ.",
            "Добавить комментарий с описанием структуры сделки."
          ]
        }
      });
    }

    const { text: limitedText, wasTruncated } = truncateText(normalizedText);

    const report = await analyzeWithOpenAI({
      extractedText: limitedText,
      checkType,
      checkName,
      comment,
      wasTruncated
    });

    res.json({
      success: true,
      meta: {
        filename: req.file.originalname,
        fileSize: req.file.size,
        checkType: checkType || null,
        checkName: checkName || null,
        extractedTextLength: normalizedText.length,
        analyzedTextLength: limitedText.length,
        wasTruncated
      },
      report
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error("Backend error:", error);

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        error: "Файл слишком большой. Максимальный размер — 20 MB."
      });
    }

    return res.status(400).json({
      success: false,
      error: `Ошибка загрузки файла: ${error.message}`
    });
  }

  const statusCode = error.statusCode || 500;

  res.status(statusCode).json({
    success: false,
    error: error.message || "Внутренняя ошибка сервера."
  });
});

app.listen(PORT, () => {
  console.log(`Shariah AI Compliance backend started on port ${PORT}`);
});
