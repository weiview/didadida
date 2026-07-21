"use client";

import { useEffect } from "react";

export default function ScrollOptimizer() {
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    
    const handleScroll = () => {
      if (!document.body.classList.contains("is-scrolling")) {
        document.body.classList.add("is-scrolling");
      }
      
      if (timer !== null) {
        clearTimeout(timer);
      }
      
      timer = setTimeout(() => {
        document.body.classList.remove("is-scrolling");
      }, 150);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (timer !== null) clearTimeout(timer);
      document.body.classList.remove("is-scrolling");
    };
  }, []);

  return null;
}
