import { expect, test } from "bun:test";
import * as bounds from "../../src/compaction/bounds.ts";
import { boundsDigests } from "./bounds-cases.ts";

// Baseline 015aee4. To regenerate: git archive 015aee4 | tar -x -C /tmp/bounds-main;
// link this repo's node_modules into /tmp/bounds-main, then run:
// bun test/compaction/bounds-cases.ts /tmp/bounds-main/src/compaction/bounds.ts
const GOLDENS = {
  "clipUtf8": {
    "count": 24008,
    "sha256": "25ec78d03eef724a1de09b7a360119c163c9ecfacfc3d660b958b86988945e04"
  },
  "boundedHeadTail": {
    "count": 24008,
    "sha256": "e0d9166e0d189f93cc73f37c446779f9ddfaf16e1d816cfb48b5791cce5705d8"
  },
  "boundedExcerpt": {
    "count": 24008,
    "sha256": "bc52386462301a998fed688ca108142d96bf869c1cebde9eeb7cb64773460d06"
  },
  "boundedTailExcerpt": {
    "count": 24008,
    "sha256": "edc41082e7bbdf7f5c07e937d8cc37a1b0fa602436e82d6c74b5037970d91282"
  },
  "protected": {
    "count": 3861,
    "sha256": "119da724d7ac9003488b7afed2e1e29d9bbdd5452bbe62c7359a5557849ebacd"
  },
  "sample": {
    "count": 651,
    "sha256": "02e7ffd9755089c5662dcfabb27727d34d3d6b5807fa9be5d3d09c1d62970512"
  },
  "surrogate": {
    "count": 528,
    "sha256": "a043e60b486ce188578533ca1ef6cbbfd17f4949dfe5671021f59b139f0a00df"
  },
  "allocation": {
    "count": 65536,
    "sha256": "6753f270aed52820843c84380a99e6b956065eeaff5185a0e4709e1d9d6bb53c"
  },
  "sections": {
    "count": 10,
    "sha256": "25c7f31f320f2f8eba158da97ff28246054b8b0cae82007f42692d3855bfeba6"
  },
  "markerDigits": {
    "count": 1629,
    "sha256": "27b7261c85b23d565571659f0a1eb99228b764a729a6d9debbf7fd382eebdb1d"
  },
  "huge": {
    "count": 54,
    "sha256": "c69b7d1baa0147ecad8809b046efdd0ccc10a2ff3689f080d186aeb1eee6ccb6"
  }
};

test("integer bounds match the 015aee4 behavior, including throws", () => {
  expect(boundsDigests(bounds)).toEqual(GOLDENS);
}, 60_000);
