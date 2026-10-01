import assert from "node:assert/strict";
import {
  applyTiAngleDrag,
  cartesianToTiAngle,
  containImageRect,
  frameMarkerRotationDeg,
  normalizeTiAngleDegrees,
  sphericalToTiAngle,
} from "../src/lib/tiAngleGeometry";

console.log("TiAngelNode 三维几何契约测试");

const front = sphericalToTiAngle({ azimuthDeg: 0, elevationDeg: 0 }, 2);
assert.deepEqual(front, { x: 0, y: 0, z: 2 });

const subjectLeft = sphericalToTiAngle({ azimuthDeg: 90, elevationDeg: 0 }, 2);
assert.ok(Math.abs(subjectLeft.x - 2) < 1e-9);
assert.ok(Math.abs(subjectLeft.z) < 1e-9);

const elevated = sphericalToTiAngle({ azimuthDeg: 0, elevationDeg: 60 }, 2);
assert.ok(elevated.y > 1.7);
assert.ok(elevated.z > 0);

const seam = cartesianToTiAngle({ x: 0, y: 0, z: -2 });
assert.equal(seam.azimuthDeg, -180);
assert.equal(seam.elevationDeg, 0);

assert.deepEqual(
  normalizeTiAngleDegrees({ azimuthDeg: 180, elevationDeg: 80, rollDeg: -40 }),
  { azimuthDeg: -180, elevationDeg: 60, rollDeg: -30 },
);

assert.deepEqual(
  applyTiAngleDrag(
    { azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 },
    { dx: 25, dy: -10, width: 100, height: 100, mode: "orbit" },
  ),
  { azimuthDeg: 90, elevationDeg: 11, rollDeg: 0 },
);
assert.deepEqual(
  applyTiAngleDrag(
    { azimuthDeg: 15, elevationDeg: 10, rollDeg: 0 },
    { dx: 12, dy: 0, width: 100, height: 100, mode: "roll" },
  ),
  { azimuthDeg: 15, elevationDeg: 10, rollDeg: 7 },
);
assert.deepEqual(
  applyTiAngleDrag(
    { azimuthDeg: 15, elevationDeg: 10, rollDeg: -4 },
    { dx: 10, dy: 40, width: 100, height: 100, mode: "azimuth" },
  ),
  { azimuthDeg: 51, elevationDeg: 10, rollDeg: -4 },
);
assert.deepEqual(
  applyTiAngleDrag(
    { azimuthDeg: 15, elevationDeg: 10, rollDeg: -4 },
    { dx: 40, dy: -10, width: 100, height: 100, mode: "elevation" },
  ),
  { azimuthDeg: 15, elevationDeg: 21, rollDeg: -4 },
);
assert.deepEqual(
  applyTiAngleDrag(
    { azimuthDeg: 170, elevationDeg: 0, rollDeg: 0 },
    { dx: 4, dy: 0, width: 100, height: 100, mode: "azimuth" },
  ),
  { azimuthDeg: -176, elevationDeg: 0, rollDeg: 0 },
);

assert.equal(frameMarkerRotationDeg(-30), -30);
assert.equal(frameMarkerRotationDeg(30), 30);
assert.deepEqual(containImageRect(1600, 800, 280, 208), {
  x: 0,
  y: 34,
  width: 280,
  height: 140,
});
assert.deepEqual(containImageRect(0, 0, 280, 208), {
  x: 0,
  y: 0,
  width: 280,
  height: 208,
});

console.log("通过正面/主体左侧、三轴边界、拖动偏移、roll 标记与 contain 测试");
