import { motion } from 'motion/react';

export function TransferSuccess({ size = 72 }: { size?: number }) {
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 72 72"
      initial={{ scale: 0.75, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{
        type: 'spring',
        stiffness: 280,
        damping: 20,
      }}
    >
      <motion.circle
        cx="36"
        cy="36"
        r="32"
        fill="var(--sage, #DCE5D2)"
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        style={{ transformOrigin: 'center' }}
      />

      <motion.path
        d="M22 36 L32 46 L51 26"
        fill="none"
        stroke="var(--forest, #344B3B)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{
          duration: 0.45,
          delay: 0.12,
          ease: [0.16, 1, 0.3, 1],
        }}
      />
    </motion.svg>
  );
}
