import { useEffect, useRef } from 'react';

export function useAutoGrow(value: string, visibilityKey?: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [value, visibilityKey]);
  return ref;
}
