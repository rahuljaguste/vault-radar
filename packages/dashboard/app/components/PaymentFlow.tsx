"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** The round trip, in order. `edge` is which pair of nodes the token travels between. */
export type Step = {
  label: string;
  detail: string;
  edge: [number, number];
  tone: "neutral" | "ok" | "warn";
};

/**
 * The x402 round trip as a scene rather than a paragraph.
 *
 * Unlike the risk universe, this one is an explainer — the shape does not encode data, it
 * encodes *sequence*, which is why the animation plays rather than being dragged. That
 * distinction is also why it does not live on the home page: three.js is ~600KB and a
 * visitor landing on a text page should not pay for a film. It is its own page, linked
 * where someone has already decided they want to understand the rail.
 *
 * The same steps are listed beside it as text, and the highlight follows the animation,
 * so the page says everything the scene says to a reader who never sees a frame.
 */
export function PaymentFlow({
  nodes,
  steps,
  // The arc sits on a shallow parabola and the camera is pitched well above it, so at 380px
  // the scene occupied about eighty pixels of its own box and read as an empty panel with
  // speckles. 240 leaves the arc the same size but stops reserving space it never used.
  height = 240,
}: {
  nodes: string[];
  steps: Step[];
  height?: number;
}): ReactNode {
  const host = useRef<HTMLDivElement | null>(null);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  // Read inside the render loop without restarting it on every step change.
  const stepRef = useRef(0);
  const playingRef = useRef(true);
  stepRef.current = current;
  playingRef.current = playing;

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;

    (async () => {
      try {
        const THREE = await import("three");
        const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
        if (disposed || !host.current) return;

        const el = host.current;
        const width = el.clientWidth || 800;
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(width, height);
        el.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
        camera.position.set(0, 5.5, 15);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.autoRotate = false;
        controls.minDistance = 6;
        controls.maxDistance = 30;

        // Nodes along a shallow arc, so every edge is visible without one node hiding another.
        const positions = nodes.map((_, i) => {
          const t = nodes.length === 1 ? 0.5 : i / (nodes.length - 1);
          const x = (t - 0.5) * 12;
          const y = Math.sin(t * Math.PI) * 2.2;
          return new THREE.Vector3(x, y, 0);
        });

        const nodeGeo = new THREE.SphereGeometry(0.28, 20, 20);
        for (const p of positions) {
          const m = new THREE.Mesh(nodeGeo, new THREE.MeshBasicMaterial({ color: 0x8a8a94 }));
          m.position.copy(p);
          scene.add(m);
        }

        const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x2f2f38 });
        for (let i = 0; i < positions.length - 1; i++) {
          scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([positions[i], positions[i + 1]]), edgeMaterial));
        }

        // The travelling token: a brighter sphere that hops along an edge per step.
        const token = new THREE.Mesh(
          new THREE.SphereGeometry(0.17, 16, 16),
          new THREE.MeshBasicMaterial({ color: 0x7aa2f7 }),
        );
        scene.add(token);

        let frame = 0;
        let elapsed = 0;
        const STEP_SECONDS = 1.8;
        const clock = new THREE.Clock();
        const animate = () => {
          frame = requestAnimationFrame(animate);
          const dt = clock.getDelta();
          if (playingRef.current) {
            elapsed += dt;
            if (elapsed >= STEP_SECONDS) {
              elapsed = 0;
              setCurrent((c) => (c + 1) % steps.length);
            }
          }
          // Ease the token across its current edge, jumping to the new edge when the step
          // changes rather than sliding back through the one it just left.
          const step = steps[stepRef.current] ?? steps[0];
          const [from, to] = step?.edge ?? [0, 1];
          const p = Math.min(1, elapsed / STEP_SECONDS);
          const eased = p * p * (3 - 2 * p);
          const a = positions[from] ?? positions[0];
          const b = positions[to] ?? positions[positions.length - 1];
          token.position.lerpVectors(a, b, eased);
          token.position.z = 0.4;
          controls.update();
          renderer.render(scene, camera);
        };
        animate();

        stop = () => {
          cancelAnimationFrame(frame);
          controls.dispose();
          nodeGeo.dispose();
          token.geometry.dispose();
          (token.material as { dispose: () => void }).dispose();
          renderer.dispose();
          renderer.domElement.remove();
        };
      } catch (e) {
        if (!disposed) setFailed(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      disposed = true;
      stop?.();
    };
  }, [nodes, steps, height]);

  const step = steps[current];

  return (
    <div className="stack">
      <div className="row between">
        <div className="row" style={{ gap: "var(--s2)" }}>
          <button type="button" onClick={() => setPlaying((p) => !p)}>
            {playing ? "pause" : "play"}
          </button>
          <button type="button" onClick={() => { setPlaying(false); setCurrent((c) => (c + 1) % steps.length); }}>
            step
          </button>
        </div>
        <span className="faint">
          step {current + 1} of {steps.length}
        </span>
      </div>

      {failed ? (
        <p className="error">Could not start WebGL ({failed}). The same steps are below.</p>
      ) : (
        <div className="scene" ref={host} style={{ height }} aria-hidden="true" />
      )}

      {/* The nodes are unlabelled spheres in the scene: text in WebGL is either a sprite that
          blurs at any zoom or a DOM overlay that drifts out of register with the camera. A
          legend in reading order is neither, and the pair each step travels between is named
          on its own card anyway. */}
      <div className="row" style={{ gap: "var(--s2)" }}>
        {nodes.map((n, i) => (
          <span key={n} className="row" style={{ gap: "var(--s2)" }}>
            <span className={step && (step.edge[0] === i || step.edge[1] === i) ? "mono" : "mono faint"}>{n}</span>
            {i < nodes.length - 1 && <span className="faint">·</span>}
          </span>
        ))}
      </div>

      <div className="grid">
        {steps.map((s, i) => (
          <div
            key={s.label}
            className={`card verdict ${i === current ? (s.tone === "neutral" ? "watch" : s.tone) : ""}`}
            onClick={() => { setPlaying(false); setCurrent(i); }}
            style={{ cursor: "pointer", opacity: i === current ? 1 : 0.55 }}
          >
            <div className="row between">
              <strong>
                {i + 1}. {s.label}
              </strong>
              <span className="mono faint">{nodes[s.edge[0]]} → {nodes[s.edge[1]]}</span>
            </div>
            <p className="faint">{s.detail}</p>
          </div>
        ))}
      </div>
      <p className="faint" aria-live="polite">
        {step ? `Step ${current + 1}: ${step.label}` : ""}
      </p>
    </div>
  );
}
