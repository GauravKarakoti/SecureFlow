'use client';

import React, { useState, useEffect } from 'react';
import { ONBOARDING_STEPS, TourStep } from './step-guides';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { X, ChevronRight, ChevronLeft } from 'lucide-react';

interface TourOverlayProps {
  isActive: boolean;
  onComplete: () => void;
  onStepUpdate: (stepIndex: number, stepId: string) => void;
}

/**
 * TourOverlay Component
 * A reusable overlay that highlights specific UI elements with explanatory tooltips.
 * Supports dark mode and dynamically positions itself based on the target element.
 */
export function TourOverlay({ isActive, onComplete, onStepUpdate }: TourOverlayProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);

  const currentStep = ONBOARDING_STEPS[currentStepIndex];

  useEffect(() => {
    if (!isActive) return;

    const updateTarget = () => {
      const element = document.querySelector(`[data-tour-id="${currentStep.target}"]`);
      if (element) {
        setTargetRect(element.getBoundingClientRect());
      }
    };

    updateTarget();
    window.addEventListener('resize', updateTarget);
    window.addEventListener('scroll', updateTarget, true);

    return () => {
      window.removeEventListener('resize', updateTarget);
      window.removeEventListener('scroll', updateTarget, true);
    };
  }, [isActive, currentStep.target]);

  if (!isActive || !targetRect) return null;

  const handleNext = () => {
    if (currentStepIndex < ONBOARDING_STEPS.length - 1) {
      const nextIndex = currentStepIndex + 1;
      setCurrentStepIndex(nextIndex);
      onStepUpdate(nextIndex, ONBOARDING_STEPS[nextIndex].id);
    } else {
      onComplete();
    }
  };

  const handlePrev = () => {
    if (currentStepIndex > 0) {
      const prevIndex = currentStepIndex - 1;
      setCurrentStepIndex(prevIndex);
      onStepUpdate(prevIndex, ONBOARDING_STEPS[prevIndex].id);
    }
  };

  // Calculate position (simplified for demonstration, defaults to center if target not found perfectly)
  const top = targetRect.bottom + 20;
  const left = targetRect.left;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/60 z-40 transition-opacity duration-300" />

      {/* Spotlight effect (simulated via border on target) */}
      <div
        className="fixed z-50 pointer-events-none ring-4 ring-purple-500 ring-offset-2 ring-offset-gray-950 rounded-lg transition-all duration-300"
        style={{
          top: targetRect.top,
          left: targetRect.left,
          width: targetRect.width,
          height: targetRect.height
        }}
      />

      {/* Tooltip Card */}
      <Card
        className="fixed z-50 w-80 p-4 bg-white dark:bg-gray-900 border-purple-500 shadow-2xl"
        style={{ top, left }}
      >
        <div className="flex justify-between items-start mb-2">
          <h3 className="font-bold text-lg text-gray-900 dark:text-gray-100">{currentStep.title}</h3>
          <button onClick={onComplete} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">{currentStep.content}</p>

        <div className="flex justify-between items-center">
          <span className="text-xs text-gray-500">
            Step {currentStepIndex + 1} of {ONBOARDING_STEPS.length}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePrev}
              disabled={currentStepIndex === 0}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button
              size="sm"
              onClick={handleNext}
              className="bg-purple-600 hover:bg-purple-700 text-white"
            >
              {currentStepIndex === ONBOARDING_STEPS.length - 1 ? 'Finish' : 'Next'}
              {currentStepIndex !== ONBOARDING_STEPS.length - 1 && <ChevronRight className="w-4 h-4 ml-1" />}
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}
