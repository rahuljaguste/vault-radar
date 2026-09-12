"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export type UniversePoint = {
  id: string;
  score: number;
  verdict: "ok" | "watch" | "alert" | "unavailable";
  /** Share-price change over 7 days, in percent. Negative is a fall. */
  change7d: number;
  /** Share-price change over 24 hours, in percent. Negative is a fall. */
  change24h: number;
};

const COLOURS: Record<UniversePoint["verdict"], number> = {
  ok: 0x4ade80,
  watch: 0xfbbf24,
  alert: 0xf87171,
  unavailable: 0x9a9aa4,
};

/**
 * The vault universe in three dimensions.
 *
 * This is the one place in the dashboard where three.js earns its weight, and the reason is
 * narrow: the axes are three *different* measurements — a week's price change, a day's price
 * change, and the risk score — so depth carries a third variable rather than decorating two.
 * A 2D chart of the same data would need three panels and the reader would have to hold them
 * in their head; here the shape answers "which vaults are drifting, how fast, and does the
 * risk engine agree".
 *
 * The first two axes are deliberately not thresholds. Plotting flag breaches was the obvious
 * choice and it produces a single dot: a healthy snapshot of real vaults trips almost no
 * threshold, so every point sits at the origin. Price change varies for every vault, which is
 * what makes the space worth looking at — and the flags still colour it.
 *
 * Loaded client-side and imported dynamically, so the ~600KB library never reaches a
 * visitor who does not open this page, and never reaches the other pages at all. When WebGL
 * is unavailable — a headless crawler, an old browser, a locked-down machine — the caller's
 * table renders instead: the same data, less insight, no blank rectangle.
 */
export function RiskUniverse({
  points,
  height = 520,
}: {
  points: UniversePoint[];
  height?: number;
}): ReactNode {
  const host = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<UniversePoint | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    // Everything the cleanup needs, kept in one place so an unmount mid-load cannot leave a
    // render loop running against a canvas that is already gone.
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
        const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
        camera.position.set(14, 10, 16);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.autoRotate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        controls.autoRotateSpeed = 0.6;

        // Axes: normalised 0..1 on each, drawn as three edges of a box so the space reads as
        // a volume rather than a cube of wires.
        const axisMaterial = new THREE.LineBasicMaterial({ color: 0x3a3a44 });
        const axes = [
          [new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0)],
          [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 10, 0)],
          [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 10)],
        ];
        for (const [from, to] of axes) {
          scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, to]), axisMaterial));
        }

        // One instanced mesh for every vault: hundreds of spheres, one draw call.
        const geometry = new THREE.SphereGeometry(0.16, 16, 16);
        const material = new THREE.MeshBasicMaterial({ vertexColors: false });
        const mesh = new THREE.InstancedMesh(geometry, material, Math.max(points.length, 1));
        // Held in a local as well as on the mesh: `instanceColor` is nullable on the type,
        // and the local is what the loop below writes through.
        const colours = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(points.length, 1) * 3), 3);
        mesh.instanceColor = colours;

        // Each axis is scaled to its own extreme: the three are in different units and a
        // shared scale would flatten whichever has the smaller spread. The two change axes
        // are signed, so their range is symmetric about zero and a vault that fell sits on
        // the opposite side of the axis from one that rose.
        const extent = (vals: number[]) => Math.max(1e-6, ...vals.map((v) => Math.abs(v)));
        const xExtent = extent(points.map((p) => p.change7d));
        const yExtent = extent(points.map((p) => p.change24h));
        const dummy = new THREE.Object3D();
        const colour = new THREE.Color();
        points.forEach((p, i) => {
          dummy.position.set(
            ((p.change7d / xExtent) * 0.5 + 0.5) * 10,
            ((p.change24h / yExtent) * 0.5 + 0.5) * 10,
            (p.score / 100) * 10,
          );
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
          colour.setHex(COLOURS[p.verdict]);
          colours.setXYZ(i, colour.r, colour.g, colour.b);
        });
        mesh.instanceMatrix.needsUpdate = true;
        colours.needsUpdate = true;
        scene.add(mesh);

        // Click to identify a point. A raycaster against the instanced mesh reports the
        // instance index, which is the array index the points were written in.
        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();
        const onClick = (event: MouseEvent) => {
          const rect = renderer.domElement.getBoundingClientRect();
          pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
          pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
          const hit = raycaster.intersectObject(mesh)[0];
          if (hit && typeof hit.instanceId === "number") setSelected(points[hit.instanceId] ?? null);
        };
        renderer.domElement.addEventListener("click", onClick);

        let frame = 0;
        const animate = () => {
          frame = requestAnimationFrame(animate);
          controls.update();
          renderer.render(scene, camera);
        };
        animate();

        stop = () => {
          cancelAnimationFrame(frame);
          renderer.domElement.removeEventListener("click", onClick);
          controls.dispose();
          geometry.dispose();
          material.dispose();
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
  }, [points, height]);

  if (failed) {
    return (
      <p className="error">
        Could not start WebGL ({failed}). The same vaults are in the table below.
      </p>
    );
  }

  return (
    <div className="stack">
      <div className="universe" ref={host} style={{ height }} aria-hidden="true" />
      <div className="row" style={{ justifyContent: "space-between", gap: "var(--s3)" }}>
        <span className="faint">
          x · 7-day price change → &nbsp; y · 24-hour price change → &nbsp; z · risk score →
        </span>
        <span className="row" style={{ gap: "var(--s2)" }}>
          {(["ok", "watch", "alert", "unavailable"] as const).map((v) => (
            <span key={v} className={`badge ${v}`}>
              {v}
            </span>
          ))}
        </span>
      </div>
      <p className="faint" aria-live="polite">
        {selected ? (
          <>
            <span className="mono" title={selected.id}>
              {selected.id}
            </span>{" "}
            — {selected.verdict}, score {selected.score}, 7d {selected.change7d >= 0 ? "+" : ""}
            {selected.change7d.toFixed(2)}%, 24h {selected.change24h >= 0 ? "+" : ""}
            {selected.change24h.toFixed(2)}%
          </>
        ) : (
          "Drag to orbit, click a vault to identify it."
        )}
      </p>
    </div>
  );
}
