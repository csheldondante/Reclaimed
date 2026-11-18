// Nested scales lab: the sandbox (step 2 onward).
export const App = {
  async start(_device: GPUDevice, _q: URLSearchParams): Promise<void> {
    document.getElementById('info')!.textContent = 'The sandbox is not built yet. Open this page with ?selftest=1.';
  },
};
