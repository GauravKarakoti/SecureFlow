/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';
import { PolicyCard } from '@/app/dashboard/policies/policy-card';

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe('Tooltip Component', () => {
  it('renders trigger element in the DOM', () => {
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger>Hover me</TooltipTrigger>
          <TooltipContent className="bg-neutral-950 text-neutral-100">
            Tooltip Information
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );

    expect(screen.getByText('Hover me')).toBeInTheDocument();
  });
});

describe('PolicyCard Component', () => {
  const mockProps = {
    id: 'test-policy-1',
    title: 'Prevent PII Logging',
    description: 'Strictly blocks logging statements that output PII.',
    isActive: true,
    severity: 'CRITICAL',
    action: 'DENY',
    rules: ['logging/pii/*', 'code/print/sensitive_data_*'],
    toggleAction: vi.fn(),
  };

  it('renders policy card title and rule conditions properly', () => {
    render(<PolicyCard {...mockProps} />);
    expect(screen.getByText('Prevent PII Logging')).toBeInTheDocument();
    expect(screen.getByText('CRITICAL')).toBeInTheDocument();
    expect(screen.getByText('DENY')).toBeInTheDocument();
    expect(screen.getByText('logging/pii/*')).toBeInTheDocument();
    expect(screen.getByText('code/print/sensitive_data_*')).toBeInTheDocument();
  });
});
