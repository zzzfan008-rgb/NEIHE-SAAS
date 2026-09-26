type Point3 = readonly [x: number, y: number, confidence: number];

type OpenPosePerson = {
  pose_keypoints_2d: number[];
  face_keypoints_2d: number[];
  hand_left_keypoints_2d: number[];
  hand_right_keypoints_2d: number[];
};

const flatten = (count: number, points: Record<number, Point3>): number[] =>
  Array.from({ length: count }, (_, index) => [...(points[index] ?? [0, 0, 0])]).flat();

const face = (count: number, left: number, top: number): number[] =>
  Array.from({ length: count }, (_, index) => [left + (index % 10) * 2, top + Math.floor(index / 10) * 2, 0.8]).flat();

const hand = (left: number, top: number): number[] =>
  Array.from({ length: 21 }, (_, index) => [left + (index % 5) * 4, top + Math.floor(index / 5) * 4, 0.75]).flat();

const person = (
  bodyCount: 18 | 25,
  body: Record<number, Point3>,
  faceCount: 0 | 68 | 70,
  faceOrigin: readonly [number, number],
  leftHandOrigin: readonly [number, number] | null,
  rightHandOrigin: readonly [number, number] | null,
): OpenPosePerson => ({
  pose_keypoints_2d: flatten(bodyCount, body),
  face_keypoints_2d: faceCount ? face(faceCount, ...faceOrigin) : [],
  hand_left_keypoints_2d: leftHandOrigin ? hand(...leftHandOrigin) : [],
  hand_right_keypoints_2d: rightHandOrigin ? hand(...rightHandOrigin) : [],
});

const crossedLegsBody25: Record<number, Point3> = {
  0: [800, 120, 0.99], 1: [800, 180, 0.95],
  2: [740, 190, 0.95], 3: [700, 260, 0.9], 4: [680, 340, 0.8],
  5: [860, 190, 0.95], 6: [900, 260, 0.9], 7: [920, 340, 0.8],
  8: [800, 400, 0.95], 9: [770, 400, 0.95], 10: [900, 550, 0.88],
  11: [820, 720, 0.85], 12: [830, 400, 0.95], 13: [650, 550, 0.88],
  14: [760, 720, 0.85], 15: [780, 120, 0.95], 16: [820, 120, 0.95],
  17: [750, 130, 0.9], 18: [850, 130, 0.9],
  19: [800, 770, 0.8], 20: [0, 0, 0], 21: [760, 745, 0.8],
  22: [650, 770, 0.8], 23: [640, 760, 0.75], 24: [700, 745, 0.8],
};

const secondPersonBody18: Record<number, Point3> = {
  0: [1150, 170, 0.9], 1: [1150, 220, 0.9],
  2: [1100, 230, 0.9], 3: [1060, 300, 0.8], 4: [1030, 360, 0.7],
  5: [1200, 230, 0.9], 6: [1240, 300, 0.8], 7: [1280, 360, 0.7],
  8: [1120, 440, 0.9], 9: [1240, 560, 0.8], 10: [1300, 680, 0.8],
  11: [1180, 440, 0.9], 12: [1050, 560, 0.8], 13: [1000, 680, 0.8],
  14: [1140, 160, 0.8], 15: [1160, 160, 0.8],
  16: [1120, 170, 0.8], 17: [1180, 170, 0.8],
};

const portraitBody25: Record<number, Point3> = {
  0: [450, 150, 0.98], 1: [450, 260, 0.9],
  2: [370, 280, 0.9], 3: [310, 420, 0.85], 4: [280, 560, 0.8],
  5: [530, 280, 0.9], 6: [590, 420, 0.85], 7: [620, 560, 0.8],
  8: [450, 720, 0.9], 9: [410, 720, 0.9], 10: [390, 1050, 0.85],
  11: [420, 1380, 0.8], 12: [490, 720, 0.9], 13: [510, 1050, 0.85],
  14: [520, 1380, 0.8], 15: [430, 145, 0.9], 16: [470, 145, 0.9],
  17: [400, 160, 0.85], 18: [500, 160, 0.85],
  19: [420, 1450, 0.75], 20: [405, 1445, 0.75], 21: [430, 1420, 0.8],
  22: [530, 1450, 0.75], 23: [545, 1445, 0.75], 24: [520, 1420, 0.8],
};

export const DWPOSE_ADJUST_OPENPOSE_SAMPLES = {
  landscapeTwoPersonCrossedLegs: {
    canvas_width: 1600,
    canvas_height: 900,
    people: [
      person(25, crossedLegsBody25, 70, [770, 125], [900, 300], [680, 300]),
      person(18, secondPersonBody18, 68, [1120, 165], [1230, 330], null),
    ],
  },
  portraitBothHandsOccluded: {
    canvas_width: 900,
    canvas_height: 1600,
    people: [person(25, portraitBody25, 70, [420, 165], null, null)],
  },
  invalid: {
    malformedJson: '{"people":',
    nonFiniteCoordinate: '{"people":[{"pose_keypoints_2d":[NaN]}]}',
    remoteImageReference: {
      canvas_width: 1600,
      canvas_height: 900,
      image_url: 'https://example.invalid/private.png',
      people: [],
    },
  },
} as const;
