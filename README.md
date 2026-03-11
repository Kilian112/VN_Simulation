# Network Traffic Simulation

Interactive browser-based simulation of Wi-Fi and cellular network traffic, built with React + Vite.

## Running with Docker

### Build the image

```bash
docker build -t vn-simulation .
```

### Run the container

```bash
docker run -p 8080:80 vn-simulation
```

Then open [http://localhost:8080](http://localhost:8080) in your browser.

To run in the background:

```bash
docker run -d -p 8080:80 --name vn-simulation vn-simulation
```

Stop it with:

```bash
docker stop vn-simulation
```

## Local development (without Docker)

Requires Node.js 18+.

```bash
npm install
npm run dev
```
