/** Render-only working fittings, visually estimated from the user's ILCA reference photograph. */
import * as THREE from 'three';
import details from '../../data/rig-details.json';
import hullDetails from '../../data/hull-details.json';
import type { BoatLayout } from './boatLayout';
import { bodyToLocal, mapToBody } from './bodyFrame';
import { merge, paint } from './land/parts';

const { block: blockDimensions, deck, colours } = details;
// VISUAL ESTIMATE: tessellation and matte finish, not mechanical/material specifications.
const ROUND_SEGMENTS = 8;
const SHEAVE_SEGMENTS = 12;
const TUBE_SEGMENTS = 6;
const PAD_HEIGHT = 0.004;
const ROUGHNESS = 0.84;

type Point = readonly [number, number, number];

function quad(vertices: number[], a: Point, b: Point, c: Point, d: Point): void {
  vertices.push(...a, ...b, ...c, ...a, ...c, ...d);
}

function triangles(vertices: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function hardwareMesh(parts: THREE.BufferGeometry[], name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(merge(parts), new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: ROUGHNESS,
    metalness: 0,
    side: THREE.DoubleSide,
  }));
  mesh.name = name;
  return mesh;
}

/** Chamfered frame, with a genuine through-aperture rather than a painted side panel. */
function cheek(x: number): THREE.BufferGeometry {
  const b = blockDimensions;
  // VISUAL ESTIMATE: corner chamfers and aperture proportions leave the sheave exposed.
  const contour = (height: number, width: number): readonly (readonly [number, number])[] => [
    [height / 2, width * 0.275], [height * 0.275, width / 2],
    [-height * 0.275, width / 2], [-height / 2, width * 0.275],
    [-height / 2, -width * 0.275], [-height * 0.275, -width / 2],
    [height * 0.275, -width / 2], [height / 2, -width * 0.275],
  ];
  const outer = contour(b.cheekHeight, b.cheekWidth);
  const inner = contour(b.cheekHeight * 0.7, b.cheekWidth * 0.74);
  const vertices: number[] = [];
  const point = (ring: typeof outer, i: number, face: number): Point => {
    const p = ring[i % ring.length]!;
    return [x + face * b.cheekThickness / 2, p[0], p[1]];
  };
  for (let i = 0; i < outer.length; i++) {
    quad(vertices, point(outer, i, 1), point(outer, i + 1, 1), point(inner, i + 1, 1), point(inner, i, 1));
    quad(vertices, point(outer, i, -1), point(inner, i, -1), point(inner, i + 1, -1), point(outer, i + 1, -1));
    quad(vertices, point(outer, i, -1), point(outer, i + 1, -1), point(outer, i + 1, 1), point(outer, i, 1));
    quad(vertices, point(inner, i, -1), point(inner, i, 1), point(inner, i + 1, 1), point(inner, i + 1, -1));
  }
  return triangles(vertices);
}

/** Seven axial rings make a visible rope groove without coincident discs or degenerate pole faces. */
function groovedSheave(): THREE.BufferGeometry {
  const b = blockDimensions;
  const width = b.width - 2 * b.cheekThickness;
  const r = b.sheaveRadius;
  // VISUAL ESTIMATE: shallow V-groove profile and rim bevels.
  const profile: readonly (readonly [number, number])[] = [
    [-width / 2, r * 0.86], [-width * 0.36, r], [-width * 0.17, r],
    [0, r * 0.83], [width * 0.17, r], [width * 0.36, r], [width / 2, r * 0.86],
  ];
  const point = (ring: number, segment: number): Point => {
    const [x, radius] = profile[ring]!;
    const angle = segment * Math.PI * 2 / SHEAVE_SEGMENTS;
    return [x, radius * Math.cos(angle), radius * Math.sin(angle)];
  };
  const vertices: number[] = [];
  for (let i = 0; i < SHEAVE_SEGMENTS; i++) {
    for (let j = 0; j < profile.length - 1; j++) {
      quad(vertices, point(j, i), point(j + 1, i), point(j + 1, i + 1), point(j, i + 1));
    }
    vertices.push(-width / 2, 0, 0, ...point(0, i + 1), ...point(0, i));
    vertices.push(width / 2, 0, 0, ...point(profile.length - 1, i), ...point(profile.length - 1, i + 1));
  }
  return triangles(vertices);
}

/** Single owned mesh: sheave centre at origin, axle along +x, attachment towards +y. */
export function createBlock(scale = 1): THREE.Mesh {
  const b = blockDimensions;
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const x = side * (b.width - b.cheekThickness) / 2;
    parts.push(paint(cheek(x), colours.body));
    // VISUAL ESTIMATE: narrow axle-support bridges keep two open apertures in each cheek.
    parts.push(paint(new THREE.BoxGeometry(b.cheekThickness, b.cheekThickness, b.cheekWidth * 0.82).translate(x, 0, 0), colours.body));
    const head = new THREE.CylinderGeometry(b.shackleTube * 1.6, b.shackleTube * 1.6, b.cheekThickness / 2, TUBE_SEGMENTS);
    head.rotateZ(-Math.PI / 2).translate(side * (b.width / 2 + b.cheekThickness / 4), 0, 0);
    parts.push(paint(head, colours.metal));
  }
  parts.push(paint(groovedSheave(), colours.sheave));
  const axle = new THREE.CylinderGeometry(b.shackleTube, b.shackleTube, b.width + b.cheekThickness, ROUND_SEGMENTS);
  parts.push(paint(axle.rotateZ(-Math.PI / 2), colours.metal));
  const attachmentY = b.cheekHeight / 2 - b.shackleTube;
  const shackle = new THREE.TorusGeometry(b.shackleRadius, b.shackleTube, TUBE_SEGMENTS, ROUND_SEGMENTS, Math.PI);
  shackle.rotateY(Math.PI / 2).translate(0, attachmentY, 0);
  parts.push(paint(shackle, colours.metal));
  const shacklePin = new THREE.CylinderGeometry(b.shackleTube, b.shackleTube, b.shackleRadius * 2, TUBE_SEGMENTS);
  shacklePin.rotateX(Math.PI / 2).translate(0, attachmentY, 0);
  parts.push(paint(shacklePin, colours.metal));
  const mesh = hardwareMesh(parts, 'open-sailing-block');
  // Scaling the owned geometry preserves a directly useful metre-scale bounding sphere.
  mesh.geometry.scale(scale, scale, scale);
  mesh.geometry.computeBoundingSphere();
  return mesh;
}

/** One lifted webbing strap, with smaller padded/seam ribbons following the same taut centreline. */
function hikingRibbon(layout: BoatLayout, aft: number, fore: number, width: number, thickness: number,
  lift = 0, start = 0, end = 1, yOffset = 0): THREE.BufferGeometry {
  const vertices: number[] = [];
  const strap = hullDetails.strap;
  const spans = strap.spans;
  const point = (i: number, side: number, face: number): Point => {
    const s = start + i / spans * (end - start);
    const x = aft + (fore - aft) * s;
    const z = layout.cockpit.floorZ + strap.anchorAboveFloor
      + Math.sin(s * Math.PI) * strap.middleRise + lift + face * thickness / 2;
    const local = bodyToLocal(x, yOffset + side * width / 2, z);
    return [local.x, local.y, local.z];
  };
  for (let i = 0; i < spans; i++) {
    quad(vertices, point(i, -1, 1), point(i, 1, 1), point(i + 1, 1, 1), point(i + 1, -1, 1));
    quad(vertices, point(i, -1, -1), point(i + 1, -1, -1), point(i + 1, 1, -1), point(i, 1, -1));
    quad(vertices, point(i, -1, -1), point(i, -1, 1), point(i + 1, -1, 1), point(i + 1, -1, -1));
    quad(vertices, point(i, 1, -1), point(i + 1, 1, -1), point(i + 1, 1, 1), point(i, 1, 1));
  }
  quad(vertices, point(0, -1, -1), point(0, 1, -1), point(0, 1, 1), point(0, -1, 1));
  quad(vertices, point(spans, -1, -1), point(spans, -1, 1), point(spans, 1, 1), point(spans, 1, -1));
  return triangles(vertices);
}

/** All static fittings in heel-group coordinates, one geometry/material and one draw call. */
export function createDeckFittings(layout: BoatLayout): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  const tube = blockDimensions.shackleTube;
  const add = (geometry: THREE.BufferGeometry, colour: THREE.ColorRepresentation, x: number, y: number, z: number): void => {
    const position = bodyToLocal(x, y, z);
    parts.push(paint(geometry.translate(position.x, position.y, position.z), colour));
  };
  const pad = (x: number, y: number, length: number, width: number): void => {
    // Each corner meets the actual sheer; small bases do not float above a sloping deck.
    const geometry = mapToBody(new THREE.BoxGeometry(length, width, PAD_HEIGHT), (px, py, pz) => [
      x + px, y + py, layout.sheerAt(x + px) + PAD_HEIGHT / 2 + pz,
    ]);
    parts.push(paint(geometry, colours.body));
  };
  const pin = (x: number, y: number, z: number): void => {
    // VISUAL ESTIMATE: short matte fastener heads, not reflective chrome or textured screws.
    add(new THREE.CylinderGeometry(tube * 1.6, tube * 1.6, tube, TUBE_SEGMENTS), colours.metal, x, y, z);
  };
  const eye = (x: number, y: number): void => {
    // VISUAL ESTIMATE: backing-pad proportions and paired fastener spacing.
    pad(x, y, deck.eyeRadius * 3, deck.eyeRadius * 2.8);
    add(new THREE.TorusGeometry(deck.eyeRadius, tube, TUBE_SEGMENTS, SHEAVE_SEGMENTS), colours.metal, x, y, layout.sheerAt(x) + deck.eyeRadius);
    for (const side of [-1, 1]) pin(x + side * deck.eyeRadius, y, layout.sheerAt(x + side * deck.eyeRadius) + PAD_HEIGHT + tube / 2);
  };

  const cleatX = layout.cockpit.fore + deck.controlForwardOfCockpit;
  const guideX = layout.mastButt.x - deck.controlAftOfMast;
  for (const side of [-1, 1]) {
    const y = side * deck.controlSpacing;
    const baseZ = layout.sheerAt(cleatX) + PAD_HEIGHT;
    pad(cleatX, y, deck.cleatWidth, deck.cleatLength);
    // VISUAL ESTIMATE: two chamfered cam jaws with a central rope gap and exposed pivot heads.
    const jawRadius = deck.cleatWidth * 0.4;
    const jawOffset = jawRadius + details.rope.controlRadius * 1.2;
    for (const jaw of [-1, 1]) {
      add(new THREE.CylinderGeometry(jawRadius * 0.86, jawRadius, deck.cleatHeight, ROUND_SEGMENTS), colours.body,
        cleatX, y + jaw * jawOffset, baseZ + deck.cleatHeight / 2);
      pin(cleatX, y + jaw * jawOffset, baseZ + deck.cleatHeight + tube / 2);
    }
    const fairleadX = cleatX + deck.cleatWidth * 0.65;
    const fairleadBase = layout.sheerAt(fairleadX) + PAD_HEIGHT;
    const postHeight = deck.cleatHeight * 0.45;
    // VISUAL ESTIMATE: a raised retaining hoop on two feet, with an open line path between the jaws.
    pad(fairleadX, y, deck.cleatWidth / 2, deck.fairleadRadius * 2.8);
    add(new THREE.TorusGeometry(deck.fairleadRadius, tube, TUBE_SEGMENTS, ROUND_SEGMENTS, Math.PI), colours.metal,
      fairleadX, y, fairleadBase + postHeight);
    for (const foot of [-1, 1]) {
      add(new THREE.CylinderGeometry(tube, tube, postHeight, TUBE_SEGMENTS), colours.metal,
        fairleadX, y + foot * deck.fairleadRadius, fairleadBase + postHeight / 2);
    }

    pad(guideX, y, deck.cleatWidth, deck.fairleadRadius * 2.8);
    add(new THREE.TorusGeometry(deck.fairleadRadius, tube, TUBE_SEGMENTS, ROUND_SEGMENTS, Math.PI), colours.metal,
      guideX, y, layout.sheerAt(guideX) + PAD_HEIGHT);
    eye(layout.transomX + deck.travellerForwardOfTransom, side * layout.model.cfg.visual.traveller.halfWidth);
  }
  // VISUAL ESTIMATE: bow eye setback reuses two cleat lengths to stay on the narrowing foredeck.
  eye(layout.bowX - deck.cleatLength * 2, 0);

  const ratchet = layout.ratchetBlock;
  const floor = layout.cockpit.floorZ;
  add(new THREE.BoxGeometry(deck.cleatWidth, PAD_HEIGHT, deck.cleatLength), colours.body, ratchet.x, ratchet.y, floor + PAD_HEIGHT / 2);
  // VISUAL ESTIMATE: the swivel base supports the inverted block's lower shackle from the floor.
  const attachmentTop = ratchet.z - blockDimensions.ratchetScale
    * (blockDimensions.cheekHeight / 2 + blockDimensions.shackleRadius);
  const eyeCentre = attachmentTop - deck.eyeRadius;
  const stemHeight = eyeCentre - deck.eyeRadius - floor - PAD_HEIGHT;
  add(new THREE.CylinderGeometry(tube * 2, tube * 2, stemHeight, TUBE_SEGMENTS), colours.metal,
    ratchet.x, ratchet.y, floor + PAD_HEIGHT + stemHeight / 2);
  add(new THREE.TorusGeometry(deck.eyeRadius, tube, TUBE_SEGMENTS, SHEAVE_SEGMENTS), colours.metal,
    ratchet.x, ratchet.y, eyeCentre);

  const strap = hullDetails.strap;
  const strapAft = layout.cockpit.aft + hullDetails.coaming.width * 0.6;
  const strapFore = layout.cockpit.fore - layout.cockpit.radius - deck.cleatLength;
  parts.push(paint(hikingRibbon(layout, strapAft, strapFore, strap.width, strap.thickness), hullDetails.colours.strap));
  const paddingLift = (strap.thickness + strap.paddingThickness) / 2;
  parts.push(paint(hikingRibbon(layout, strapAft, strapFore, strap.paddingWidth, strap.paddingThickness,
    paddingLift, 0.08, 0.92), hullDetails.colours.strap));
  for (const side of [-1, 1]) {
    parts.push(paint(hikingRibbon(layout, strapAft, strapFore, strap.seamWidth, strap.seamWidth,
      paddingLift + strap.paddingThickness / 2, 0.1, 0.9, side * strap.paddingWidth * 0.43), hullDetails.colours.strapSeam));
  }
  // Aft plate is seated against the well end; the forward bracket has two legs
  // on a screwed floor pad, clear of the existing ratchet block and board path.
  const anchorZ = floor + strap.anchorAboveFloor;
  add(new THREE.BoxGeometry(strap.anchorWidth, strap.anchorLength, PAD_HEIGHT), colours.metal,
    layout.cockpit.aft + PAD_HEIGHT / 2, 0, anchorZ);
  add(new THREE.BoxGeometry(strap.anchorWidth, PAD_HEIGHT, strap.anchorLength), colours.body,
    strapFore, 0, floor + PAD_HEIGHT / 2);
  for (const side of [-1, 1]) {
    const y = side * strap.anchorWidth * 0.42;
    add(new THREE.BoxGeometry(PAD_HEIGHT, strap.anchorAboveFloor, PAD_HEIGHT), colours.metal,
      strapFore, y, floor + strap.anchorAboveFloor / 2);
    pin(strapFore, y, floor + PAD_HEIGHT + tube / 2);
    const aftScrew = new THREE.CylinderGeometry(tube * 1.6, tube * 1.6, tube, TUBE_SEGMENTS);
    add(aftScrew.rotateX(Math.PI / 2), colours.body, layout.cockpit.aft + PAD_HEIGHT + tube / 2, y, anchorZ);
  }
  for (const x of [strapAft, strapFore]) {
    add(new THREE.BoxGeometry(strap.anchorWidth, PAD_HEIGHT, strap.anchorLength), colours.metal, x, 0, anchorZ - strap.thickness / 2 - PAD_HEIGHT / 2);
  }

  const rail = hullDetails.gripRail;
  const railAft = layout.cockpit.aft + rail.endInset;
  const railFore = Math.min(railAft + rail.length, layout.cockpit.fore - rail.endInset);
  const railLength = railFore - railAft;
  for (const side of [-1, 1]) {
    // The strip's outer edge is buried in the actual wall, not floating on deck.
    const y = side * (layout.cockpit.halfWidth - rail.width * 0.42);
    const railGeometry = new THREE.CapsuleGeometry(rail.height / 2, railLength - rail.height, 2, 6);
    railGeometry.rotateZ(Math.PI / 2);
    railGeometry.scale(1, rail.width / rail.height, 1);
    parts.push(paint(mapToBody(railGeometry, (px, py, pz) => [
      (railAft + railFore) / 2 + px, y + py, layout.sheerAt((railAft + railFore) / 2 + px) - rail.belowSheer + pz,
    ]), hullDetails.colours.rail));
    for (const x of [railAft + rail.fastenerInset, (railAft + railFore) / 2, railFore - rail.fastenerInset]) {
      pin(x, y, layout.sheerAt(x) - rail.belowSheer + rail.height / 2 + tube / 2);
    }
  }

  const fittings = hullDetails.fittings;
  const board = layout.model.cfg.daggerboard;
  const leading = layout.transomX + board.leadingEdgeXFromTransom;
  const trailing = leading - board.chord;
  const boardMiddle = (leading + trailing) / 2;
  const margin = fittings.collarMargin;
  const collar = (x: number, y: number, length: number, width: number): void => {
    parts.push(paint(mapToBody(new THREE.BoxGeometry(length, width, fittings.collarHeight), (px, py, pz) => [
      x + px, y + py, layout.sheerAt(x + px) + fittings.collarHeight / 2 + pz,
    ]), hullDetails.colours.collar));
  };
  // Four bars form an actual open slot collar around the existing board slab.
  for (const side of [-1, 1]) {
    collar(boardMiddle, side * (board.thickness + margin) / 2, board.chord + 2 * margin, margin);
    collar(side < 0 ? trailing - margin / 2 : leading + margin / 2, 0, margin, board.thickness);
    pin(boardMiddle, side * (board.thickness + margin) / 2, layout.sheerAt(boardMiddle) + fittings.collarHeight + tube / 2);
  }
  const boardTop = layout.sheerAt(leading) + layout.model.cfg.visual.daggerboard.topAboveDeck;
  const handle = new THREE.TorusGeometry(fittings.handleRadius, fittings.handleTube, TUBE_SEGMENTS, SHEAVE_SEGMENTS, Math.PI);
  add(handle.rotateY(Math.PI / 2), colours.body, boardMiddle, 0, boardTop - fittings.handleTube);
  const elasticAnchorX = leading + margin * 5;
  const elasticAnchorY = deck.controlSpacing;
  const elasticAnchorZ = layout.sheerAt(elasticAnchorX) + PAD_HEIGHT;
  pad(elasticAnchorX, elasticAnchorY, margin * 2, margin * 2);
  pin(elasticAnchorX, elasticAnchorY, elasticAnchorZ + tube / 2);
  const elasticPoints = [
    bodyToLocal(boardMiddle, fittings.handleTube, boardTop + fittings.handleRadius),
    bodyToLocal(leading + margin, elasticAnchorY * 0.55, (boardTop + elasticAnchorZ) / 2),
    bodyToLocal(elasticAnchorX, elasticAnchorY, elasticAnchorZ + tube),
  ];
  parts.push(paint(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(elasticPoints), 12,
    fittings.retainingRadius, TUBE_SEGMENTS, false), hullDetails.colours.elastic));

  const capX = layout.cockpit.aft - fittings.inspectionAftOfCockpit;
  const capY = fittings.inspectionSideOffset;
  const capHeight = fittings.inspectionHeight;
  const capSurface = (geometry: THREE.BufferGeometry, lift: number, colour: THREE.ColorRepresentation): void => {
    parts.push(paint(mapToBody(geometry, (px, py, pz) => [
      capX + pz, capY + px, layout.sheerAt(capX + pz) + lift + py,
    ]), colour));
  };
  capSurface(new THREE.CylinderGeometry(fittings.inspectionRadius, fittings.inspectionRadius, capHeight, 16),
    capHeight / 2, hullDetails.colours.collar);
  capSurface(new THREE.CylinderGeometry(fittings.inspectionRadius * 0.88, fittings.inspectionRadius * 0.88, capHeight / 2, 16),
    capHeight * 1.25, hullDetails.colours.gelcoat);
  add(new THREE.BoxGeometry(fittings.inspectionRadius * 0.55, capHeight / 2, margin * 0.3), hullDetails.colours.railEdge,
    capX, capY, layout.sheerAt(capX) + capHeight * 1.6);
  for (const side of [-1, 1]) pin(capX, capY + side * fittings.inspectionRadius * 0.72,
    layout.sheerAt(capX) + capHeight * 1.5 + tube / 2);

  const drainX = layout.transomX - PAD_HEIGHT / 2;
  const drainY = fittings.drainSideOffset;
  const drainZ = layout.keelAt(layout.transomX) + fittings.drainAboveKeel;
  add(new THREE.CylinderGeometry(fittings.drainRadius * 1.6, fittings.drainRadius * 1.6, PAD_HEIGHT, ROUND_SEGMENTS).rotateX(Math.PI / 2),
    hullDetails.colours.collar, drainX, drainY, drainZ);
  add(new THREE.CylinderGeometry(fittings.drainRadius, fittings.drainRadius, PAD_HEIGHT * 1.5, ROUND_SEGMENTS).rotateX(Math.PI / 2),
    colours.body, drainX - PAD_HEIGHT, drainY, drainZ);
  for (const side of [-1, 1]) {
    add(new THREE.CylinderGeometry(tube * 1.6, tube * 1.6, tube, TUBE_SEGMENTS).rotateX(Math.PI / 2),
      colours.metal, drainX - PAD_HEIGHT / 2 - tube / 2, drainY + side * fittings.drainRadius * 2, drainZ);
  }
  return hardwareMesh(parts, 'working-deck-fittings');
}
