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

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB per file
const MAX_TEXT_CHARS = 90000;

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

const documentFields = [
  {
    fieldName: "contractFile",
    label: "Основной договор сделки",
    required: true
  },
  {
    fieldName: "assetFile",
    label: "Документы по активу",
    required: false
  },
  {
    fieldName: "paymentFile",
    label: "Платежи, комиссии и просрочка",
    required: false
  },
  {
    fieldName: "policyFile",
    label: "Внутренняя Shariah policy банка",
    required: false
  },
  {
    fieldName: "file",
    label: "Загруженный документ",
    required: false
  }
];

function getFileExtension(filename) {
  return path.extname(filename || "").toLowerCase();
}

function validateFileExtension(file) {
  const extension = getFileExtension(file.originalname);
  const allowedExtensions = [".txt", ".pdf", ".docx"];

  if (!allowedExtensions.includes(extension)) {
    const error = new Error(
      `Неподдерживаемый формат файла "${file.originalname}". Разрешены: .txt, .pdf, .docx`
    );
    error.statusCode = 400;
    throw error;
  }
}

async function extractTextFromFile(file) {
  if (!file) {
    throw new Error("Файл не был загружен.");
  }

  validateFileExtension(file);

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

function getFirstFile(filesByField, fieldName) {
  const value = filesByField?.[fieldName];
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }

  return null;
}

async function buildDocumentPackage(filesByField) {
  const uploadedDocuments = [];
  const missingRecommendedDocuments = [];

  for (const config of documentFields) {
    const file = getFirstFile(filesByField, config.fieldName);

    if (!file) {
      if (!config.required && config.fieldName !== "file") {
        missingRecommendedDocuments.push(config.label);
      }
      continue;
    }

    const rawText = await extractTextFromFile(file);
    const normalizedText = normalizeText(rawText);

    uploadedDocuments.push({
      fieldName: config.fieldName,
      label: config.label,
      filename: file.originalname,
      fileSize: file.size,
      textLength: normalizedText.length,
      text: normalizedText
    });
  }

  return {
    uploadedDocuments,
    missingRecommendedDocuments
  };
}

function buildCombinedText(uploadedDocuments) {
  return uploadedDocuments
    .map((doc) => {
      return [
        `=== ${doc.label} ===`,
        `Файл: ${doc.filename}`,
        `Извлечено символов: ${doc.textLength}`,
        "",
        doc.text || "Текст не извлечен."
      ].join("\n");
    })
    .join("\n\n---\n\n");
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

Твоя задача — провести комплексную предварительную Shariah Compliance проверку пакета документов по сделке.

Ты анализируешь не один пункт, а весь пакет сделки:
- основной договор сделки;
- документы по активу;
- график платежей, комиссии и условия просрочки;
- внутреннюю Shariah policy банка, если она загружена.

Важно:
Ты не выдаешь финальную фетву.
Ты не заменяешь Shariah Board.
Ты не заменяешь Shariah Officer.
Ты готовишь предварительный отчет, который экономит ручную работу compliance-команды и помогает Shariah Officer быстро увидеть спорные места.

Проверь пакет документов по следующим направлениям:
1. Возможные элементы riba / interest.
2. Gharar / excessive uncertainty.
3. Maysir / gambling-like risk.
4. Наличие и описание актива.
5. Переход собственности и риск ownership / asset transfer.
6. Комиссии: являются ли они понятными, обоснованными и не скрывают ли interest.
7. Late payment clauses: штрафы, пени, компенсации, charity mechanism, риск получения прибыли от просрочки.
8. График платежей и условия отсрочки.
9. Соответствие структуре Murabaha / Ijarah / Sukuk, если применимо.
10. Наличие или отсутствие внутренней Shariah policy банка.
11. Каких документов или пунктов не хватает.
12. Какие вопросы должен проверить Shariah Officer.

Если часть документов не загружена:
- не выдумывай их содержание;
- прямо укажи, чего не хватает;
- снизь уверенность проверки;
- добавь это в findings и nextSteps.

Если текст документа слишком короткий, неполный или непонятный:
- поставь riskLevel: "Средний";
- укажи, что данных недостаточно для уверенной проверки;
- предложи загрузить полный документ или добавить внутреннюю Shariah policy банка.

Отвечай только на русском языке.
Верни строго JSON по заданной схеме.
`;

async function analyzeWithOpenAI({
  extractedText,
  checkType,
  checkName,
  comment,
  wasTruncated,
  uploadedDocuments,
  missingRecommendedDocuments
}) {
  if (!openai) {
    const error = new Error("OPENAI_API_KEY отсутствует. Добавьте ключ в Render Environment Variables.");
    error.statusCode = 500;
    throw error;
  }

  const uploadedList = uploadedDocuments
    .map((doc) => `- ${doc.label}: ${doc.filename}`)
    .join("\n");

  const missingList = missingRecommendedDocuments.length
    ? missingRecommendedDocuments.map((label) => `- ${label}`).join("\n")
    : "Нет";

  const userPrompt = `
Тип анализа: ${checkType || "Комплексная предварительная проверка сделки"}
Название проверки: ${checkName || "Не указано"}
Комментарий системы/сотрудника банка: ${comment || "Нет комментария"}

Загруженные документы:
${uploadedList || "Нет"}

Не загружены рекомендованные документы:
${missingList}

Пакет документов был обрезан из-за ограничения размера текста: ${wasTruncated ? "Да" : "Нет"}

Текст пакета документов:
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
    model: OPENAI_MODEL,
    supportsMultipleFiles: true
  });
});

app.post(
  "/api/check-document",
  upload.fields([
    { name: "contractFile", maxCount: 1 },
    { name: "assetFile", maxCount: 1 },
    { name: "paymentFile", maxCount: 1 },
    { name: "policyFile", maxCount: 1 },
    { name: "file", maxCount: 1 }
  ]),
  async (req, res, next) => {
    try {
      const { checkType, checkName, comment } = req.body;

      const { uploadedDocuments, missingRecommendedDocuments } = await buildDocumentPackage(req.files || {});

      const hasMainContract = uploadedDocuments.some(
        (doc) => doc.fieldName === "contractFile" || doc.fieldName === "file"
      );

      if (!hasMainContract) {
        return res.status(400).json({
          success: false,
          error: "Основной договор сделки обязателен. Передайте файл в поле contractFile."
        });
      }

      const combinedText = buildCombinedText(uploadedDocuments);
      const normalizedText = normalizeText(combinedText);

      if (!normalizedText || normalizedText.length < 50) {
        return res.json({
          success: true,
          meta: {
            checkType: checkType || null,
            checkName: checkName || null,
            files: uploadedDocuments.map((doc) => ({
              fieldName: doc.fieldName,
              label: doc.label,
              filename: doc.filename,
              fileSize: doc.fileSize,
              textLength: doc.textLength
            })),
            missingRecommendedDocuments,
            extractedTextLength: normalizedText.length,
            warning: "Из документов извлечено слишком мало текста для уверенной проверки."
          },
          report: {
            overallStatus: "Требует проверки специалистом",
            riskLevel: "Средний",
            complianceScore: 50,
            issuesFound: 1,
            recommendation: "Загрузить полный пакет документов и передать Shariah Officer для финального подтверждения",
            aiSummary: "Из загруженных документов извлечено слишком мало текста. Данных недостаточно для уверенной Shariah Compliance проверки.",
            findings: [
              "Недостаточно текста для анализа riba, gharar, maysir, комиссий, просрочки платежа и перехода собственности."
            ],
            nextSteps: [
              "Проверить качество загруженных файлов.",
              "Загрузить полный основной договор сделки.",
              "Добавить документы по активу, платежам и внутреннюю Shariah policy банка, если они есть."
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
        wasTruncated,
        uploadedDocuments,
        missingRecommendedDocuments
      });

      res.json({
        success: true,
        meta: {
          checkType: checkType || null,
          checkName: checkName || null,
          files: uploadedDocuments.map((doc) => ({
            fieldName: doc.fieldName,
            label: doc.label,
            filename: doc.filename,
            fileSize: doc.fileSize,
            textLength: doc.textLength
          })),
          missingRecommendedDocuments,
          extractedTextLength: normalizedText.length,
          analyzedTextLength: limitedText.length,
          wasTruncated
        },
        report
      });
    } catch (error) {
      next(error);
    }
  }
);

app.use((error, req, res, next) => {
  console.error("Backend error:", error);

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        error: "Файл слишком большой. Максимальный размер — 20 MB на один файл."
      });
    }

    if (error.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({
        success: false,
        error: `Неправильное поле файла: ${error.field}. Ожидаются contractFile, assetFile, paymentFile, policyFile.`
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
