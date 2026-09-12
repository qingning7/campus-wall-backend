import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import XLSX from "xlsx";
import { prisma } from "../src/lib/prisma.js";

const NAME_COLUMNS = [
  "学校名称",
  "高校名称",
  "name",
  "school_name",
  "schoolname",
];

const LEVEL_COLUMNS = ["办学层次", "层次", "学校层次", "level", "school_level"];

type CliOptions = {
  filePath: string;
  dryRun: boolean;
};

type SchoolRecord = Record<string, string>;

function printUsage() {
  console.log("用法:");
  console.log("  npm run import:schools -- <文件路径>");
  console.log("");
  console.log("示例:");
  console.log("  npm run import:schools -- ./data/undergraduate-schools.csv");
  console.log(
    "  npm run import:schools -- ./data/undergraduate-schools.json --dry-run",
  );
  console.log("");
  console.log("支持格式:");
  console.log("  .json  数组，可为字符串数组或对象数组");
  console.log("  .csv   表格文件，默认读取 UTF-8");
  console.log("  .tsv   制表符分隔表格");
  console.log("  .txt   每行一个学校名");
  console.log("  .xlsx  Excel 文件，默认读取第一个工作表");
  console.log("  .xls   Excel 文件，默认读取第一个工作表");
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const filePath = args.find((arg) => !arg.startsWith("--"));

  if (!filePath) {
    printUsage();
    process.exit(1);
  }

  return {
    filePath,
    dryRun,
  };
}

function normalizeCell(value: string) {
  return value.replace(/^\uFEFF/, "").trim();
}

function normalizeHeader(value: string) {
  return normalizeCell(value).toLowerCase().replace(/\s+/g, "");
}

function normalizeSchoolName(value: string) {
  return normalizeCell(value).replace(/\s+/g, " ");
}

function splitDelimitedLine(line: string, delimiter: string) {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }

      continue;
    }

    if (char === delimiter && !inQuotes) {
      cells.push(normalizeCell(current));
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(normalizeCell(current));
  return cells;
}

function parseDelimitedRecords(content: string, delimiter: string) {
  const lines = content
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return [];
  }

  const headerLine = lines[0] ?? "";
  const dataLines = lines.slice(1);
  const headerCells = splitDelimitedLine(headerLine, delimiter);
  const headers = headerCells.map(normalizeHeader);

  return dataLines.map((line) => {
    const values = splitDelimitedLine(line, delimiter);
    const record: SchoolRecord = {};

    headers.forEach((header, index) => {
      if (!header) {
        return;
      }

      record[header] = values[index] ?? "";
    });

    return record;
  });
}

function buildRecordsFromTableRows(rows: string[][]) {
  if (rows.length === 0) {
    return [];
  }

  const headerIndex = rows.findIndex((row) =>
    row.some((cell) => NAME_COLUMNS.includes(normalizeHeader(cell))),
  );

  if (headerIndex === -1) {
    throw new Error("找不到包含“学校名称”列的表头");
  }

  const headerCells = rows[headerIndex] ?? [];
  const dataRows = rows.slice(headerIndex + 1);
  const headers = headerCells.map(normalizeHeader);

  return dataRows.map((row) => {
    const record: SchoolRecord = {};

    headers.forEach((header, index) => {
      if (!header) {
        return;
      }

      record[header] = row[index] ?? "";
    });

    return record;
  });
}

function pickColumn(record: SchoolRecord, candidates: string[]) {
  for (const candidate of candidates) {
    const value = record[normalizeHeader(candidate)];
    if (value) {
      return value;
    }
  }

  return "";
}

function shouldKeepRecord(record: SchoolRecord) {
  const level = pickColumn(record, LEVEL_COLUMNS);

  if (!level) {
    return true;
  }

  return level.includes("本科");
}

function extractNameFromRecord(record: SchoolRecord) {
  const rawName = pickColumn(record, NAME_COLUMNS);

  if (!rawName) {
    return "";
  }

  if (!shouldKeepRecord(record)) {
    return "";
  }

  return normalizeSchoolName(rawName);
}

function parseJsonNames(content: string) {
  const data: unknown = JSON.parse(content);

  if (!Array.isArray(data)) {
    throw new Error("JSON 文件必须是数组");
  }

  const names: string[] = [];

  for (const item of data) {
    if (typeof item === "string") {
      const name = normalizeSchoolName(item);
      if (name) {
        names.push(name);
      }
      continue;
    }

    if (item && typeof item === "object") {
      const name = extractNameFromRecord(item as SchoolRecord);
      if (name) {
        names.push(name);
      }
    }
  }

  return names;
}

function parseTxtNames(content: string) {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map(normalizeSchoolName)
    .filter((name) => name.length > 0);
}

function parseExcelNames(filePath: string) {
  const workbook = XLSX.readFile(filePath);
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    throw new Error("Excel 文件中没有工作表");
  }

  const worksheet = workbook.Sheets[firstSheetName];

  if (!worksheet) {
    throw new Error(`找不到工作表: ${firstSheetName}`);
  }

  const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(
    worksheet,
    {
      header: 1,
      raw: false,
      defval: "",
    },
  );

  const normalizedRows = rows
    .map((row) => row.map((cell) => normalizeCell(String(cell ?? ""))))
    .filter((row) => row.some((cell) => cell.length > 0));

  return buildRecordsFromTableRows(normalizedRows).map(extractNameFromRecord);
}

function parseFileContent(filePath: string, content: string) {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".json":
      return parseJsonNames(content);
    case ".csv":
      return parseDelimitedRecords(content, ",").map(extractNameFromRecord);
    case ".tsv":
      return parseDelimitedRecords(content, "\t").map(extractNameFromRecord);
    case ".txt":
      return parseTxtNames(content);
    case ".xlsx":
    case ".xls":
      return parseExcelNames(filePath);
    default:
      throw new Error(`暂不支持的文件格式: ${extension || "无扩展名"}`);
  }
}

function uniqueNames(names: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const name of names) {
    if (!name || seen.has(name)) {
      continue;
    }

    seen.add(name);
    result.push(name);
  }

  return result;
}

async function main() {
  const { filePath, dryRun } = parseArgs(process.argv);
  const absolutePath = path.resolve(process.cwd(), filePath);
  const extension = path.extname(absolutePath).toLowerCase();
  const content =
    extension === ".xlsx" || extension === ".xls"
      ? ""
      : await readFile(absolutePath, "utf8");
  const parsedNames = parseFileContent(absolutePath, content);
  const names = uniqueNames(parsedNames.filter((name) => name.length > 0));

  if (names.length === 0) {
    throw new Error("没有解析到可导入的学校名，请检查文件内容或列名");
  }

  const existingSchools = await prisma.school.findMany({
    select: { name: true },
  });

  const existingNameSet = new Set(existingSchools.map((school) => school.name));
  const namesToCreate = names.filter((name) => !existingNameSet.has(name));

  console.log(`文件路径: ${absolutePath}`);
  console.log(`解析到学校数: ${names.length}`);
  console.log(`数据库已存在: ${existingNameSet.size}`);
  console.log(`待新增学校数: ${namesToCreate.length}`);

  if (dryRun) {
    console.log("");
    console.log("当前为 dry-run，没有写入数据库。");
    return;
  }

  if (namesToCreate.length === 0) {
    console.log("");
    console.log("没有需要新增的学校，导入结束。");
    return;
  }

  const result = await prisma.school.createMany({
    data: namesToCreate.map((name) => ({ name })),
    skipDuplicates: true,
  });

  console.log("");
  console.log(`成功新增 ${result.count} 所学校。`);
}

main()
  .catch((error: unknown) => {
    console.error("");
    console.error("导入失败。");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
