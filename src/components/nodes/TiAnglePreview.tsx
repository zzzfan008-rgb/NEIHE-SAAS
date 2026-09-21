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
  normalizeTiAngleDegrees,
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
  dragAxis: (start: TiAngleConfig, mode: TiAngleDragMode, dx: number, dy: number) => TiAngleConfig;
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

function createArcGeometry(THREE: ThreeModule) {
  const points = Array.from({ length: 49 }, (_, index) => {
    const angle = ((-45 + (index / 48) * 105) * Math.PI) / 180;
    return new THREE.Vector3(-Math.cos(angle) * 1.85, Math.sin(angle) * 1.85, 0);
  });
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 64, 0.026, 8, false);
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
        const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 40);
        camera.position.set(4, 3, 6);
        camera.lookAt(0, 0, 0);
        const accent = new THREE.Color("#dfff45");
        scene.add(new THREE.AmbientLight(0xffffff, 1.6));
        const keyLight = new THREE.DirectionalLight(0xffffff, 3);
        keyLight.position.set(-3, 6, 5);
        scene.add(keyLight);
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.7);
        fillLight.position.set(4, 1, -3);
        scene.add(fillLight);

        const imageMaterial = new THREE.MeshBasicMaterial({
          color: image ? 0xffffff : 0x68686b,
          side: THREE.FrontSide,
        });
        const imagePlane = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 1.8), imageMaterial);
        scene.add(imagePlane);
        // A neutral back prevents the source photograph from looking like a generated rear view.
        const imageBack = new THREE.Mesh(
          new THREE.PlaneGeometry(1.35, 1.8),
          new THREE.MeshBasicMaterial({ color: 0x505054, side: THREE.BackSide }),
        );
        scene.add(imageBack);
        const cardBorder = new THREE.LineLoop(
          createRectGeometry(THREE, 1.35, 1.8),
          new THREE.LineBasicMaterial({ color: 0xbebec2 }),
        );
        scene.add(cardBorder);
        const cardTop = new THREE.Mesh(
          new THREE.ConeGeometry(0.055, 0.12, 3),
          new THREE.MeshBasicMaterial({ color: accent }),
        );
        cardTop.position.set(0, 0.78, 0.012);
        scene.add(cardTop);

        const orbitMaterial = new THREE.MeshStandardMaterial({ color: 0xc5c5c8, roughness: 0.48, metalness: 0.15 });
        const orbit = new THREE.Mesh(new THREE.TorusGeometry(1.85, 0.028, 8, 96), orbitMaterial);
        orbit.rotation.x = Math.PI / 2;
        orbit.position.y = -0.94;
        scene.add(orbit);
        const elevationArc = new THREE.Mesh(createArcGeometry(THREE), orbitMaterial);
        scene.add(elevationArc);

        const ball = new THREE.Mesh(
          new THREE.SphereGeometry(0.14, 24, 16),
          new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.25, roughness: 0.35 }),
        );
        scene.add(ball);

        const cameraRig = new THREE.Group();
        const cameraArrow = new THREE.Mesh(
          new THREE.ConeGeometry(0.16, 0.36, 4),
          new THREE.MeshStandardMaterial({ color: accent, roughness: 0.5 }),
        );
        cameraArrow.rotation.x = Math.PI / 2;
        cameraArrow.position.z = 0.3;
        cameraRig.add(cameraArrow);
        const frame = new THREE.LineLoop(
          createRectGeometry(THREE, 0.38, 0.27),
          new THREE.LineBasicMaterial({ color: accent }),
        );
        const frameTop = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-0.06, 0.135, 0),
            new THREE.Vector3(0, 0.22, 0),
            new THREE.Vector3(0.06, 0.135, 0),
          ]),
          new THREE.LineBasicMaterial({ color: accent }),
        );
        frame.add(frameTop);
        frame.position.z = 0.52;
        cameraRig.add(frame);
        scene.add(cameraRig);

        const azimuthHandle = new THREE.Mesh(
          new THREE.SphereGeometry(0.16, 24, 16),
          new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.24, metalness: 0.2 }),
        );
        scene.add(azimuthHandle);

        const elevationHandle = new THREE.Mesh(
          new THREE.SphereGeometry(0.16, 24, 16),
          new THREE.MeshStandardMaterial({ color: 0xaaaaae, roughness: 0.3, metalness: 0.18 }),
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
          const fit = containImageRect(width, height, 160, 180);
          const planeWidth = fit.width / 100;
          const planeHeight = fit.height / 100;
          imagePlane.geometry.dispose();
          imagePlane.geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
          imageBack.geometry.dispose();
          imageBack.geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
          cardBorder.geometry.dispose();
          cardBorder.geometry = createRectGeometry(THREE, planeWidth, planeHeight);
          cardTop.position.y = planeHeight / 2 - 0.08;
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
          const position = sphericalToTiAngle(current, 1.35);
          const markerPosition = new THREE.Vector3(
            position.x,
            position.y,
            position.z,
          );
          ball.position.copy(markerPosition);
          ballHitTarget.position.copy(markerPosition);
          cameraRig.position.copy(markerPosition);
          cameraRig.lookAt(0, 0, 0);

          const azimuthRadians = (current.azimuthDeg * Math.PI) / 180;
          const azimuthPosition = new THREE.Vector3(
            Math.sin(azimuthRadians) * 1.85,
            -0.94,
            Math.cos(azimuthRadians) * 1.85,
          );
          azimuthHandle.position.copy(azimuthPosition);
          azimuthHitTarget.position.copy(azimuthPosition);

          const elevationRadians = (current.elevationDeg * Math.PI) / 180;
          const elevationPosition = new THREE.Vector3(
            -Math.cos(elevationRadians) * 1.85,
            Math.sin(elevationRadians) * 1.85,
            0,
          );
          elevationHandle.position.copy(elevationPosition);
          elevationHitTarget.position.copy(elevationPosition);

          directionLine.geometry.setFromPoints([
            new THREE.Vector3(0, 0, 0),
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
            imageBack,
            ballHitTarget,
            azimuthHitTarget,
            elevationHitTarget,
          ]);
          const first = intersections[0]?.object;
          if (!first || first === imagePlane || first === imageBack) return null;
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
          camera.aspect = aspect;
          camera.updateProjectionMatrix();
          render();
        };

        // Match the projected track, preserving the initial grab offset rather than
        // treating a perspective orbit as a horizontal screen-space slider.
        const dragAxis: PreviewScene["dragAxis"] = (start, mode, dx, dy) => {
          const rect = canvas.getBoundingClientRect();
          const projectAngle = (degrees: number) => {
            const radians = (degrees * Math.PI) / 180;
            const point = mode === "azimuth"
              ? new THREE.Vector3(Math.sin(radians) * 1.85, -0.94, Math.cos(radians) * 1.85)
              : new THREE.Vector3(-Math.cos(radians) * 1.85, Math.sin(radians) * 1.85, 0);
            point.project(camera);
            return { x: point.x * rect.width / 2, y: -point.y * rect.height / 2 };
          };
          const initial = mode === "azimuth" ? start.azimuthDeg : start.elevationDeg;
          const origin = projectAngle(initial);
          let best = initial;
          let distance = Infinity;
          const min = mode === "azimuth" ? initial - 180 : -45;
          const max = mode === "azimuth" ? initial + 180 : 60;
          for (let angle = min; angle <= max; angle++) {
            const point = projectAngle(angle);
            const candidate = (point.x - origin.x - dx) ** 2 + (point.y - origin.y - dy) ** 2;
            if (candidate < distance) {
              best = angle;
              distance = candidate;
            }
          }
          return { ...start, ...normalizeTiAngleDegrees({ ...start,
            ...(mode === "azimuth" ? { azimuthDeg: best } : { elevationDeg: best }),
          }) };
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
          dragAxis,
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
    const next: TiAngleConfig = (active.mode === "azimuth" || active.mode === "elevation") && sceneRef.current
      ? sceneRef.current.dragAxis(active.start, active.mode, event.clientX - active.startX, event.clientY - active.startY)
      : { ...active.start, ...nextDegrees };
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
      className="relative h-52 overflow-hidden rounded-lg border border-[var(--gc-node-border)] bg-[#38383b]"
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
      <div className="pointer-events-none absolute top-2 right-2 rounded bg-[var(--gc-node-main)]/80 px-1.5 py-0.5 font-mono text-[9px] text-[var(--gc-node-muted)]">
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
