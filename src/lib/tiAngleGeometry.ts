export interface TiAngleDegrees {
  azimuthDeg: number;
  elevationDeg: number;
  rollDeg: number;
}

export interface TiAngleCartesian {
  x: number;
  y: number;
  z: number;
}

export type TiAngleDragMode = "orbit" | "azimuth" | "elevation" | "roll";

export interface TiAngleDragDelta {
  dx: number;
  dy: number;
  width: number;
  height: number;
  mode: TiAngleDragMode;
}

export const TI_ANGLE_GEOMETRY_LIMITS = {
  azimuthDeg: { min: -180, max: 180 },
  elevationDeg: { min: -45, max: 60 },
  rollDeg: { min: -30, max: 30 },
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function wrapAzimuth(value: number): number {
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
  return wrapped === 0 ? 0 : wrapped;
}

/** Keep pointer-derived values aligned with the persisted one-degree contract. */
export function normalizeTiAngleDegrees(value: TiAngleDegrees): TiAngleDegrees {
  return {
    azimuthDeg: wrapAzimuth(Math.round(value.azimuthDeg)),
    elevationDeg: Math.round(
      clamp(
        value.elevationDeg,
        TI_ANGLE_GEOMETRY_LIMITS.elevationDeg.min,
        TI_ANGLE_GEOMETRY_LIMITS.elevationDeg.max,
      ),
    ),
    rollDeg: Math.round(
      clamp(
        value.rollDeg,
        TI_ANGLE_GEOMETRY_LIMITS.rollDeg.min,
        TI_ANGLE_GEOMETRY_LIMITS.rollDeg.max,
      ),
    ),
  };
}

/** Convert the UI convention to a subject-centered orbit: front is +Z, +azimuth is subject-left. */
export function sphericalToTiAngle(
  angle: Pick<TiAngleDegrees, "azimuthDeg" | "elevationDeg">,
  radius: number,
): TiAngleCartesian {
  const azimuth = (angle.azimuthDeg * Math.PI) / 180;
  const elevation = (angle.elevationDeg * Math.PI) / 180;
  const horizontal = Math.cos(elevation) * radius;
  return {
    x: Math.sin(azimuth) * horizontal,
    y: Math.sin(elevation) * radius,
    z: Math.cos(azimuth) * horizontal,
  };
}

export function cartesianToTiAngle(point: TiAngleCartesian): Pick<TiAngleDegrees, "azimuthDeg" | "elevationDeg"> {
  const radius = Math.hypot(point.x, point.y, point.z);
  if (radius === 0) return { azimuthDeg: 0, elevationDeg: 0 };
  return normalizeTiAngleDegrees({
    azimuthDeg: (Math.atan2(point.x, point.z) * 180) / Math.PI,
    elevationDeg: (Math.asin(clamp(point.y / radius, -1, 1)) * 180) / Math.PI,
    rollDeg: 0,
  });
}

/** Apply a captured pointer delta without accumulating seam or clamp errors. */
export function applyTiAngleDrag(
  start: TiAngleDegrees,
  delta: TiAngleDragDelta,
): TiAngleDegrees {
  const width = Math.max(1, delta.width);
  const height = Math.max(1, delta.height);
  const next = { ...start };
  if (delta.mode === "orbit" || delta.mode === "azimuth") {
    next.azimuthDeg += (delta.dx / width) * 360;
  }
  if (delta.mode === "orbit" || delta.mode === "elevation") {
    next.elevationDeg -= (delta.dy / height) * 105;
  }
  if (delta.mode === "roll") {
    next.rollDeg += (delta.dx / width) * 60;
  }
  return normalizeTiAngleDegrees(next);
}

/** Roll is a frame marker only; it must never be applied to the orbit or subject mesh. */
export function frameMarkerRotationDeg(rollDeg: number): number {
  return clamp(Math.round(rollDeg), TI_ANGLE_GEOMETRY_LIMITS.rollDeg.min, TI_ANGLE_GEOMETRY_LIMITS.rollDeg.max);
}

export interface TiAngleImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function containImageRect(
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): TiAngleImageRect {
  if (imageWidth <= 0 || imageHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return { x: 0, y: 0, width: Math.max(0, viewportWidth), height: Math.max(0, viewportHeight) };
  }
  const scale = Math.min(viewportWidth / imageWidth, viewportHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    x: (viewportWidth - width) / 2,
    y: (viewportHeight - height) / 2,
    width,
    height,
  };
}
