export type WallPoint = {
  x: number;
  y: number;
};

export type WallStrokeInput = {
  color: string;
  size: number;
  points: WallPoint[];
};

export const WALL_WIDTH = 2400;
export const WALL_HEIGHT = 1400;
const MIN_BRUSH_SIZE = 1;
const MAX_BRUSH_SIZE = 48;
const MIN_POINTS = 2;
const MAX_POINTS = 1000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)
}

function isValidPoint(value: unknown): value is WallPoint {
  if (!isPlainObject(value)) {
    return false;
  }

  const { x, y } =value;

  return (
    typeof x === "number" &&
    typeof y === "number" &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    x <= WALL_WIDTH &&
    y >= 0 &&
    y <= WALL_HEIGHT
  );
}

export function validateWallStrokeInput(input: unknown): WallStrokeInput {
  if (!isPlainObject(input)) {
    throw new Error("Stroke input must be an object");
  }

  const candidate = input as Record<string, unknown>
  const { color, size, points } = input;

  if (!isValidColor(color)) {
    throw new Error("Stroke color must be a hex color");
  }

  if (
    typeof size !== "number" || 
    !Number.isInteger(size) || 
    size < MIN_BRUSH_SIZE ||
    size > MAX_BRUSH_SIZE
  ) {
    throw new Error("stroke size is invalid");
  }

  if (!Array.isArray(points)) {
    throw new Error("Stroke points must be an array");
  }

  if (points.length < MIN_POINTS) {
    throw new Error("Stroke must contain at least 2 points");
  }

  if (points.length > MAX_POINTS) {
    throw new Error("Stroke contains too many points");
  }

   if (!points.every(isValidPoint)) {
    throw new Error("Stroke points are invalid");
  }

  return {
    color,
    size,
    points
  };
}