import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { RefreshCwIcon, Rotate3dIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Material, Mesh, Texture } from "three";
import {
  applyTiAngleDrag,
  containImageRect,
  frameMarkerRotationDeg,
  sphericalToTiAngle,
  type TiAngleDragMode,
} from "@/lib/tiAngleGeometry";
import type { TiAngleConfig } from "@/types/workflow";

interface TiAnglePreviewProps {
  image?: string;
  config: TiAngleConfig;
  disabled?: boolean;
  onCommit: (config: TiAngleConfig) => void;
}

interface ActiveDrag {
  pointerId: number;
  startX: number;
  startY: number;
  start: TiAngleConfig;
  mode: TiAngleDragMode;
  changed: boolean;
}

interface PreviewScene {
  render: () => void;
  hitTest: (clientX: number, clientY: number) => TiAngleDragMode | null;
  dispose: () => void;
}

type TextureState = "empty" | "loading" | "loaded" | "error";

type ThreeModule = typeof import("@/lib/tiAngleThreeRuntime");

function signedAngle(value: number): string {
  return `${value > 0 ? "+" : ""}${value}°`;
}

function sameAngle(left: TiAngleConfig, right: TiAngleConfig): boolean {
  return (
    left.azimuthDeg === right.azimuthDeg &&
    left.elevationDeg === right.elevationDeg &&
    left.rollDeg === right.rollDeg &&
    left.enabled === right.enabled
  );
}

function createRectGeometry(THREE: ThreeModule, width: number, height: number) {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  return new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-halfWidth, -halfHeight, 0),
    new THREE.Vector3(halfWidth, -halfHeight, 0),
    new THREE.Vector3(halfWidth, halfHeight, 0),
    new THREE.Vector3(-halfWidth, halfHeight, 0),
  ]);
}

function createEllipseGeometry(THREE: ThreeModule, radiusX: number, radiusY: number) {
  const curve = new THREE.EllipseCurve(0, 0, radiusX, radiusY, 0, Math.PI * 2, false, 0);
  return new THREE.BufferGeometry().setFromPoints(
    curve.getPoints(96).map((point) => new THREE.Vector3(point.x, point.y, 0)),
  );
}

function createArcGeometry(THREE: ThreeModule, radiusX: number, radiusY: number) {
  const curve = new THREE.EllipseCurve(
    0,
    0,
    radiusX,
    radiusY,
    -Math.PI / 2,
    Math.PI / 2,
    false,
    0,
  );
  return new THREE.BufferGeometry().setFromPoints(
    curve.getPoints(48).map((point) => new THREE.Vector3(point.x, point.y, 0.01)),
  );
}

export function TiAnglePreview({ image, config, disabled = false, onCommit }: TiAnglePreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draftRef = useRef(config);
  const activeDragRef = useRef<ActiveDrag | null>(null);
  const sceneRef = useRef<PreviewScene | null>(null);
  const [draft, setDraft] = useState(config);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [textureState, setTextureState] = useState<TextureState>(image ? "loading" : "empty");
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (activeDragRef.current) return;
    draftRef.current = config;
    setDraft(config);
  }, [config]);

  useEffect(() => {
    draftRef.current = draft;
    sceneRef.current?.render();
  }, [draft]);

  useEffect(() => {
    let cancelled = false;
    let currentScene: PreviewScene | null = null;
    sceneRef.current?.dispose();
    sceneRef.current = null;
    setRendererError(null);
    setTextureState(image ? "loading" : "empty");

    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return undefined;

    void Promise.all([
      import("@/lib/tiAngleThreeRuntime"),
      import("@/lib/tiAngleThreeRenderer"),
    ]).then(([THREE, rendererModule]) => {
      if (cancelled) return;

      try {
        const renderer = new rendererModule.WebGLRenderer({
          canvas,
          antialias: true,
          alpha: true,
          powerPreference: "low-power",
        });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        renderer.setPixelRatio(dpr);
        renderer.setClearColor(0x000000, 0);

        const scene = new THREE.Scene();
        const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 20);
        camera.position.set(0, 0, 6);
        camera.lookAt(0, 0, 0);

        const accent = new THREE.Color("#8bd8ff");
        const muted = new THREE.Color("#557080");
        const cssAccent = getComputedStyle(host).getPropertyValue("--gc-accent").trim();
        if (cssAccent) {
          try {
            accent.setStyle(cssAccent);
          } catch {
            // CSS custom properties may use a color syntax older Three.js cannot parse.
          }
        }

        const imageMaterial = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: image ? 0.92 : 0.12,
          side: THREE.DoubleSide,
        });
        const imagePlane = new THREE.Mesh(new THREE.PlaneGeometry(2.55, 1.7), imageMaterial);
        imagePlane.position.z = -0.08;
        scene.add(imagePlane);

        const frameMaterial = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.62 });
        const frame = new THREE.LineLoop(createRectGeometry(THREE, 2.68, 1.83), frameMaterial);
        frame.position.z = 0.08;
        scene.add(frame);

        const orbitMaterial = new THREE.LineBasicMaterial({ color: muted, transparent: true, opacity: 0.72 });
        const orbit = new THREE.LineLoop(createEllipseGeometry(THREE, 1.42, 0.58), orbitMaterial);
        orbit.position.z = 0.03;
        scene.add(orbit);

        const elevationArc = new THREE.Line(createArcGeometry(THREE, 0.68, 1.02), orbitMaterial);
        elevationArc.position.z = 0.04;
        scene.add(elevationArc);

        const axisMaterial = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.3 });
        const axis = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-1.6, 0, 0),
            new THREE.Vector3(1.6, 0, 0),
          ]),
          axisMaterial,
        );
        axis.position.z = 0.02;
        scene.add(axis);

        const ball = new THREE.Mesh(
          new THREE.SphereGeometry(0.1, 18, 12),
          new THREE.MeshBasicMaterial({ color: accent }),
        );
        scene.add(ball);

        const azimuthHandle = new THREE.Mesh(
          new THREE.SphereGeometry(0.075, 16, 10),
          new THREE.MeshBasicMaterial({ color: accent }),
        );
        scene.add(azimuthHandle);

        const elevationHandle = new THREE.Mesh(
          new THREE.SphereGeometry(0.075, 16, 10),
          new THREE.MeshBasicMaterial({ color: 0xffd88b }),
        );
        scene.add(elevationHandle);

        const createHitTarget = (radius: number) => {
          const material = new THREE.MeshBasicMaterial({
            transparent: true,
            opacity: 0,
            depthWrite: false,
          });
          material.colorWrite = false;
          return new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), material);
        };
        const ballHitTarget = createHitTarget(0.28);
        const azimuthHitTarget = createHitTarget(0.22);
        const elevationHitTarget = createHitTarget(0.22);
        scene.add(ballHitTarget, azimuthHitTarget, elevationHitTarget);

        const directionLine = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0.2),
            new THREE.Vector3(0, 0, 0.2),
          ]),
          new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.9 }),
        );
        scene.add(directionLine);

        let loadedTexture: Texture | null = null;
        let imageWidth = 0;
        let imageHeight = 0;

        const fitImagePlane = (width: number, height: number) => {
          const fit = containImageRect(width, height, 255, 170);
          const planeWidth = 2.55 * (fit.width / 255);
          const planeHeight = 1.7 * (fit.height / 170);
          imagePlane.geometry.dispose();
          imagePlane.geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
          frame.geometry.dispose();
          frame.geometry = createRectGeometry(THREE, planeWidth + 0.13, planeHeight + 0.13);
        };

        if (image) {
          const loader = new THREE.TextureLoader();
          loadedTexture = loader.load(
            image,
            (texture) => {
              if (cancelled) {
                texture.dispose();
                return;
              }
              setTextureState("loaded");
              imageWidth = texture.image?.naturalWidth ?? texture.image?.width ?? 0;
              imageHeight = texture.image?.naturalHeight ?? texture.image?.height ?? 0;
              if (imageWidth > 0 && imageHeight > 0) fitImagePlane(imageWidth, imageHeight);
              texture.colorSpace = THREE.SRGBColorSpace;
              imageMaterial.map = texture;
              imageMaterial.needsUpdate = true;
              renderer.render(scene, camera);
            },
            undefined,
            () => {
              if (!cancelled) {
                setTextureState("error");
                setRendererError("示意参考图无法加载，仍可使用空场景调整视角");
              }
            },
          );
        }

        const render = () => {
          const current = draftRef.current;
          const position = sphericalToTiAngle(current, 1.55);
          const markerPosition = new THREE.Vector3(
            position.x * 1.12,
            position.y * 1.12,
            position.z * 1.12,
          );
          ball.position.copy(markerPosition);
          ballHitTarget.position.copy(markerPosition);

          const azimuthRadians = (current.azimuthDeg * Math.PI) / 180;
          const azimuthPosition = new THREE.Vector3(
            Math.sin(azimuthRadians) * 1.42,
            Math.cos(azimuthRadians) * 0.58,
            Math.cos(azimuthRadians) * 0.75,
          );
          azimuthHandle.position.copy(azimuthPosition);
          azimuthHitTarget.position.copy(azimuthPosition);

          const elevationRadians =
            ((current.elevationDeg + 45) / 105) * Math.PI - Math.PI / 2;
          const elevationPosition = new THREE.Vector3(
            Math.cos(elevationRadians) * 0.68,
            Math.sin(elevationRadians) * 1.02,
            0.24,
          );
          elevationHandle.position.copy(elevationPosition);
          elevationHitTarget.position.copy(elevationPosition);

          directionLine.geometry.setFromPoints([
            new THREE.Vector3(0, 0, 0.2),
            markerPosition,
          ]);
          frame.rotation.z = (frameMarkerRotationDeg(current.rollDeg) * Math.PI) / 180;
          renderer.render(scene, camera);
        };

        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();
        const hitTest = (clientX: number, clientY: number): TiAngleDragMode | null => {
          const rect = canvas.getBoundingClientRect();
          if (
            rect.width <= 0 ||
            rect.height <= 0 ||
            clientX < rect.left ||
            clientX > rect.right ||
            clientY < rect.top ||
            clientY > rect.bottom
          ) {
            return null;
          }
          pointer.set(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1,
          );
          raycaster.setFromCamera(pointer, camera);
          const intersections = raycaster.intersectObjects([
            imagePlane,
            ballHitTarget,
            azimuthHitTarget,
            elevationHitTarget,
          ]);
          const first = intersections[0]?.object;
          if (!first || first === imagePlane) return null;
          if (first === ballHitTarget) return "orbit";
          if (first === azimuthHitTarget) return "azimuth";
          if (first === elevationHitTarget) return "elevation";
          return null;
        };

        const resize = () => {
          const rect = host.getBoundingClientRect();
          const width = Math.max(1, Math.floor(rect.width || host.clientWidth || 280));
          const height = Math.max(1, Math.floor(rect.height || host.clientHeight || 208));
          renderer.setSize(width, height, false);
          const aspect = width / height;
          camera.left = -2 * aspect;
          camera.right = 2 * aspect;
          camera.top = 2;
          camera.bottom = -2;
          camera.updateProjectionMatrix();
          render();
        };

        const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
        resizeObserver?.observe(host);
        window.addEventListener("resize", resize);

        const handleContextLost = (event: Event) => {
          event.preventDefault();
          setRendererError("WebGL 预览暂时不可用，可重试恢复");
        };
        const handleContextRestored = () => {
          setRendererError(null);
          resize();
        };
        canvas.addEventListener("webglcontextlost", handleContextLost, false);
        canvas.addEventListener("webglcontextrestored", handleContextRestored, false);

        currentScene = {
          render,
          hitTest,
          dispose: () => {
            resizeObserver?.disconnect();
            window.removeEventListener("resize", resize);
            canvas.removeEventListener("webglcontextlost", handleContextLost);
            canvas.removeEventListener("webglcontextrestored", handleContextRestored);
            loadedTexture?.dispose();
            scene.traverse((object) => {
              const disposable = object as Mesh & {
                material?: Material | Material[];
              };
              disposable.geometry?.dispose();
              const materials = disposable.material
                ? Array.isArray(disposable.material)
                  ? disposable.material
                  : [disposable.material]
                : [];
              materials.forEach((material) => {
                const textureMaterial = material as Material & { map?: Texture | null };
                textureMaterial.map?.dispose();
                material.dispose();
              });
            });
            renderer.dispose();
            scene.clear();
          },
        };
        sceneRef.current = currentScene;
        resize();
      } catch {
        setTextureState(image ? "error" : "empty");
        setRendererError("WebGL 预览暂时不可用，可重试恢复");
      }
    }).catch(() => {
      if (!cancelled) {
        setTextureState(image ? "error" : "empty");
        setRendererError("Three.js 预览加载失败，可重试恢复");
      }
    });

    return () => {
      cancelled = true;
      if (sceneRef.current === currentScene) {
        sceneRef.current?.dispose();
        sceneRef.current = null;
      }
    };
  }, [image, retryNonce]);

  useEffect(() => {
    const cancelDrag = () => {
      const active = activeDragRef.current;
      if (!active) return;
      activeDragRef.current = null;
      draftRef.current = active.start;
      setDraft(active.start);
    };
    window.addEventListener("blur", cancelDrag);
    return () => window.removeEventListener("blur", cancelDrag);
  }, []);

  const updateDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const active = activeDragRef.current;
    if (!active) {
      const mode = disabled
        ? null
        : sceneRef.current?.hitTest(event.clientX, event.clientY);
      event.currentTarget.style.cursor = mode ? "grab" : "default";
      return;
    }
    if (event.pointerId !== active.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.style.cursor = "grabbing";
    const rect = event.currentTarget.getBoundingClientRect();
    const nextDegrees = applyTiAngleDrag(active.start, {
      dx: event.clientX - active.startX,
      dy: event.clientY - active.startY,
      width: rect.width,
      height: rect.height,
      mode: active.mode,
    });
    const next: TiAngleConfig = { ...active.start, ...nextDegrees };
    active.changed = !sameAngle(active.start, next);
    draftRef.current = next;
    setDraft(next);
  };

  const finishDrag = (event: ReactPointerEvent<HTMLCanvasElement>, commit: boolean) => {
    const active = activeDragRef.current;
    if (!active || event.pointerId !== active.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const next = draftRef.current;
    activeDragRef.current = null;
    if (commit && active.changed && !sameAngle(active.start, next)) onCommit(next);
    if (!commit) {
      draftRef.current = active.start;
      setDraft(active.start);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.currentTarget.style.cursor = "default";
  };

  const cancelDrag = () => {
    const active = activeDragRef.current;
    if (!active) return;
    activeDragRef.current = null;
    draftRef.current = active.start;
    setDraft(active.start);
    if (canvasRef.current) canvasRef.current.style.cursor = "default";
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const mode = sceneRef.current?.hitTest(event.clientX, event.clientY);
    event.currentTarget.focus();
    if (!mode) return;
    event.preventDefault();
    event.stopPropagation();
    activeDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      start: draftRef.current,
      mode,
      changed: false,
    };
    event.currentTarget.style.cursor = "grabbing";
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  return (
    <div
      ref={hostRef}
      data-ti-angle-preview="true"
      data-ti-angle-image-state={textureState}
      aria-label="3D 视角预览"
      className="relative h-36 overflow-hidden rounded-lg border border-[var(--gc-node-border)] bg-[radial-gradient(circle_at_center,color-mix(in_srgb,var(--gc-accent)_13%,transparent),transparent_66%),var(--gc-node-inner)]"
    >
      <canvas
        ref={canvasRef}
        aria-label="Three.js 3D 视角交互预览"
        className="nodrag nopan absolute inset-0 size-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-[var(--gc-accent)]"
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        data-disabled={disabled ? "true" : undefined}
        style={{ opacity: disabled ? 0.72 : 1 }}
        onPointerDown={handlePointerDown}
        onPointerMove={updateDrag}
        onPointerUp={(event) => finishDrag(event, true)}
        onPointerCancel={(event) => finishDrag(event, false)}
        onPointerLeave={(event) => {
          if (!activeDragRef.current) event.currentTarget.style.cursor = "default";
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") cancelDrag();
        }}
        onBlur={cancelDrag}
      />
      <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1 text-[9px] text-[var(--gc-node-muted)]">
        <Rotate3dIcon aria-hidden="true" className="size-3" />
        拖动相机球调整视角
      </div>
      <span className="sr-only">示意参考图</span>
      <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-[var(--gc-node-main)]/80 px-1.5 py-0.5 font-mono text-[9px] text-[var(--gc-node-muted)]">
        {signedAngle(draft.azimuthDeg)} / {signedAngle(draft.elevationDeg)} / {signedAngle(draft.rollDeg)}
      </div>
      {rendererError && (
        <div className="absolute inset-x-2 bottom-2 flex items-center justify-between gap-2 rounded-md border border-[var(--gc-node-border)] bg-[var(--gc-node-main)]/90 px-2 py-1 text-[9px] text-[var(--gc-node-muted)]">
          <span>{rendererError}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="重试 3D 预览"
            onClick={() => setRetryNonce((value) => value + 1)}
            className="nodrag"
          >
            <RefreshCwIcon aria-hidden="true" />
          </Button>
        </div>
      )}
      {image && textureState === "loading" && <span className="sr-only">正在加载示意参考图</span>}
      {image && textureState === "loaded" && <span className="sr-only">已加载示意参考图</span>}
      {image && textureState === "error" && <span className="sr-only">示意参考图加载失败</span>}
    </div>
  );
}
