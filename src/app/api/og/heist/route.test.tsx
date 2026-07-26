import { describe, it, expect, vi, beforeEach } from 'vitest';

// 1. Mock fetch globally BEFORE importing the route
vi.hoisted(() => {
  const mockArrayBuffer = new ArrayBuffer(8);
  global.fetch = vi.fn().mockResolvedValue({
    arrayBuffer: vi.fn().mockResolvedValue(mockArrayBuffer),
  });
});

// 2. Mock next/og to return a simple mock ImageResponse
const mockImageResponseConstructor = vi.fn();
vi.mock('next/og', () => {
  return {
    ImageResponse: class MockImageResponse {
      element: any;
      options: any;
      status: number;
      headers: Headers;

      constructor(element: any, options?: any) {
        mockImageResponseConstructor(element, options);
        this.element = element;
        this.options = options;
        this.status = 200;
        this.headers = new Headers({
          'Content-Type': 'image/png',
          ...options?.headers,
        });
      }
    },
  };
});

// 3. Mock next/server to provide Request as NextRequest
vi.mock('next/server', () => {
  return {
    NextRequest: Request,
  };
});

// 4. Test suite
describe('GET /api/og/heist', () => {
  beforeEach(() => {
    mockImageResponseConstructor.mockClear();
    vi.mocked(global.fetch).mockClear();
    vi.resetModules();
  });

  it('successfully returns a valid image response with default parameters', async () => {
    // Dynamic import to ensure module is evaluated fresh with current mocks
    const { GET } = await import('./route');
    const { NextRequest } = await import('next/server');

    const req = new NextRequest('http://localhost/api/og/heist');
    const res = await GET(req as any);

    expect(res).toBeDefined();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');

    expect(mockImageResponseConstructor).toHaveBeenCalledTimes(1);
    const [element, options] = mockImageResponseConstructor.mock.calls[0];

    // Check defaults are populated in JSX element
    const elementString = JSON.stringify(element);
    expect(elementString).toContain('Classified Target');
    expect(elementString).toContain('The Professor');
    expect(elementString).toContain('100');

    // Check sizes and options
    expect(options).toEqual(expect.objectContaining({
      width: 1200,
      height: 630,
      fonts: expect.arrayContaining([
        expect.objectContaining({ name: 'Orbitron', weight: 400 }),
        expect.objectContaining({ name: 'Orbitron', weight: 700 }),
      ]),
    }));
  });

  it('renders correct text with provided search parameters', async () => {
    const { GET } = await import('./route');
    const { NextRequest } = await import('next/server');

    const req = new NextRequest(
      'http://localhost/api/og/heist?project=RoyalMint&alias=Tokyo&score=85&timestamp=2026-07-14'
    );
    const res = await GET(req as any);

    expect(res.status).toBe(200);
    expect(mockImageResponseConstructor).toHaveBeenCalledTimes(1);
    const [element] = mockImageResponseConstructor.mock.calls[0];

    const elementString = JSON.stringify(element);
    expect(elementString).toContain('RoyalMint');
    expect(elementString).toContain('Tokyo');
    expect(elementString).toContain('85');
    expect(elementString).toContain('2026-07-14');
  });

  it('handles and limits extremely long query params correctly', async () => {
    const { GET } = await import('./route');
    const { NextRequest } = await import('next/server');

    const longProject = 'P'.repeat(100);
    const longAlias = 'A'.repeat(50);

    const req = new NextRequest(
      `http://localhost/api/og/heist?project=${longProject}&alias=${longAlias}`
    );
    const res = await GET(req as any);

    expect(res.status).toBe(200);
    const [element] = mockImageResponseConstructor.mock.calls[0];
    const elementString = JSON.stringify(element);

    // Limit is 60 for project
    expect(elementString).toContain('P'.repeat(60));
    expect(elementString).not.toContain('P'.repeat(61));

    // Limit is 30 for alias
    expect(elementString).toContain('A'.repeat(30));
    expect(elementString).not.toContain('A'.repeat(31));
  });

  it('handles invalid, negative, or excessive scores gracefully', async () => {
    const { GET } = await import('./route');
    const { NextRequest } = await import('next/server');

    // Case 1: non-numeric defaults to 100
    const req1 = new NextRequest('http://localhost/api/og/heist?score=not-a-number');
    await GET(req1 as any);
    expect(JSON.stringify(mockImageResponseConstructor.mock.calls[0][0])).toContain('100');

    // Case 2: negative clamps to 0
    const req2 = new NextRequest('http://localhost/api/og/heist?score=-10');
    await GET(req2 as any);
    expect(JSON.stringify(mockImageResponseConstructor.mock.calls[1][0])).toContain('0');

    // Case 3: > 100 clamps to 100
    const req3 = new NextRequest('http://localhost/api/og/heist?score=125');
    await GET(req3 as any);
    expect(JSON.stringify(mockImageResponseConstructor.mock.calls[2][0])).toContain('100');
  });

  it('renders dynamic rank, findingsCount, and stolen parameters', async () => {
    const { GET } = await import('./route');
    const { NextRequest } = await import('next/server');

    const req = new NextRequest(
      'http://localhost/api/og/heist?project=BankOfSpain&alias=Nairobi&score=95&rank=S&findingsCount=2&stolen=5000000'
    );
    const res = await GET(req as any);

    expect(res.status).toBe(200);
    expect(mockImageResponseConstructor).toHaveBeenCalledTimes(1);
    const [element] = mockImageResponseConstructor.mock.calls[0];

    const elementString = JSON.stringify(element);
    expect(elementString).toContain('BankOfSpain');
    expect(elementString).toContain('Nairobi');
    expect(elementString).toContain('RANK S');
    expect(elementString).toContain('Findings Logged');
    expect(elementString).toContain('2');
    expect(elementString).toContain('5000000');
  });

  it('returns status 500 when font loading or parsing fails', async () => {
    // Override fetch mock to reject, simulating a network / file read failure
    vi.mocked(global.fetch).mockRejectedValueOnce(new Error('Failed to load font files'));

    const { GET } = await import('./route');
    const { NextRequest } = await import('next/server');

    const req = new NextRequest('http://localhost/api/og/heist');
    const res = await GET(req as any);

    expect(res).toBeDefined();
    expect(res.status).toBe(500);

    const bodyText = await res.text();
    expect(bodyText).toBe('Failed to generate image');
  });
});
