import type { Transition } from "motion/react";

export const springs = {
  responsive: {
    type: "spring",
    stiffness: 500,
    damping: 35,
    mass: 0.7,
  },

  smooth: {
    type: "spring",
    stiffness: 260,
    damping: 28,
    mass: 0.9,
  },

  fluid: {
    type: "spring",
    stiffness: 180,
    damping: 24,
    mass: 1,
  },

  tactile: {
    type: "spring",
    stiffness: 600,
    damping: 32,
    mass: 0.5,
  },
} satisfies Record<string, Transition>;

export const easing = {
  standard: [0.25, 0.1, 0.25, 1],
  emphasized: [0.16, 1, 0.3, 1],
  exit: [0.4, 0, 1, 1],
} as const;

export const reveal = {
  initial: {
    opacity: 0,
    y: 18,
    scale: 0.98,
  },

  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
  },

  exit: {
    opacity: 0,
    y: -8,
    scale: 0.98,
  },
};
