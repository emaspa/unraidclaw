export const dockerList = [{
  id: `97ace1454062${"a".repeat(52)}:8cfbfc9d8945${"b".repeat(3)}`,
  image: "grafana/grafana",
  state: "RUNNING",
  status: "Up 5 hours",
  names: ["/Grafana"],
  autoStart: true,
}];

export const dockerLogs = {
  id: "Grafana",
  logs: "2026-09-16T10:00:00Z Starting Grafana\n2026-09-16T10:00:01Z HTTP server listening\n",
};

export const syslog = {
  entries: ["Sep 16 10:00:00 tower kernel: Fixture boot complete", "Sep 16 10:00:01 tower emhttpd: Fixture array started"],
  total: 2,
};

export const arrayStatus = {
  state: "STARTED",
  capacity: {
    kilobytes: { free: 2147483648, used: 1073741824, total: 3221225472 },
    human: { free: "2.00 TiB", used: "1.00 TiB", total: "3.00 TiB" },
  },
  disks: [{ name: "disk1", device: "sdb", size: 3221225472, status: "DISK_OK", temp: 30 }],
};
