import { render, screen } from '@testing-library/react';
import App from './App';

test('renders the traffic dashboard heading', async () => {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: async () => ({
        bundlePath: 'C:\\bundle',
        configPath: 'C:\\bundle\\configs\\runtime.yaml',
        defaultVideoPath: 'C:\\video.mp4',
        defaults: {
          processFps: 10,
          emitIntervalSec: 1,
          realtime: true,
        },
        lanes: ['N', 'E', 'S', 'W'],
        video: {
          durationSec: 10,
          frameCount: 100,
        },
      }),
    })
  );

  render(<App />);
  const heading = screen.getByRole('heading', {
    name: /interactive command dashboard for four-way traffic flow analysis/i,
  });
  expect(heading).toBeInTheDocument();
  expect(await screen.findByText(/backend online/i)).toBeInTheDocument();
});
