/**
 * Configuration for the interactive onboarding tour steps.
 * Each step targets a specific UI element (via data-tour-id) and provides context.
 */
export const ONBOARDING_STEPS = [
  {
    id: 'welcome',
    target: 'tour-dashboard-overview',
    title: 'Welcome to Mission Control',
    content: 'This is your centralized command center. Here you can view the overall security posture of all your repositories.',
    placement: 'center' as const
  },
  {
    id: 'findings',
    target: 'tour-findings-list',
    title: 'Breach Attempts',
    content: 'This section lists all detected vulnerabilities, hardcoded secrets, and code flaws. Click on any finding to see detailed AI remediation steps.',
    placement: 'bottom' as const
  },
  {
    id: 'policies',
    target: 'tour-policies-engine',
    title: 'Defense Strategy',
    content: 'Customize your security rules here. You can enable, disable, or create custom regex patterns to fit your organization\'s specific needs.',
    placement: 'left' as const
  },
  {
    id: 'armor-score',
    target: 'tour-armor-iq-score',
    title: 'ArmorIQ Score',
    content: 'Your repository\'s security health is quantified here. Aim for a high score by resolving critical findings and enforcing strict policies.',
    placement: 'top' as const
  }
];

export type TourStep = typeof ONBOARDING_STEPS[number];
export type TourStepId = TourStep['id'];
export type TourStepTarget = TourStep['target'];
export type TourStepPlacement = TourStep['placement'];
export type TourStepContent = TourStep['content'];
export type TourStepTitle = TourStep['title'];
