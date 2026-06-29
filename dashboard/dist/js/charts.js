export class BurnChart {
    constructor(canvasElement) {
        this.chart = new Chart(canvasElement, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Cost ($)',
                        data: [],
                        backgroundColor: '#8b5cf6',
                        borderRadius: 4,
                        borderWidth: 0,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        backgroundColor: '#18181b',
                        titleColor: '#fff',
                        bodyColor: '#a1a1aa',
                        borderColor: '#27272a',
                        borderWidth: 1,
                        callbacks: {
                            label: (context) => `$${context.parsed.y.toFixed(4)}`,
                        },
                    },
                },
                scales: {
                    x: {
                        grid: { display: false, drawBorder: false },
                        ticks: { color: '#a1a1aa', font: { size: 9 } },
                    },
                    y: {
                        grid: { color: '#27272a', drawBorder: false },
                        ticks: {
                            color: '#a1a1aa',
                            font: { size: 9 },
                            callback: (value) => `$${value.toFixed(2)}`,
                        },
                        beginAtZero: true,
                    },
                },
                interaction: { mode: 'nearest', axis: 'x', intersect: false },
            },
        });
    }
    update(dailyData) {
        if (!dailyData || !Array.isArray(dailyData))
            dailyData = [];
        const grouped = {};
        for (const row of dailyData) {
            if (!row || !row.date)
                continue;
            grouped[row.date] = (grouped[row.date] || 0) + (row.cost || 0);
        }
        const sortedDates = Object.keys(grouped).sort();
        this.chart.data.labels = sortedDates.map((d) => d.slice(5));
        this.chart.data.datasets[0].data = sortedDates.map((d) => grouped[d]);
        this.chart.update();
    }
    destroy() {
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
    }
}
export class ModelChart {
    constructor(canvasElement) {
        this.chart = new Chart(canvasElement, {
            type: 'doughnut',
            data: {
                labels: [],
                datasets: [
                    {
                        data: [],
                        backgroundColor: [
                            '#8b5cf6',
                            '#3b82f6',
                            '#10b981',
                            '#f59e0b',
                            '#06b6d4',
                            '#f43f5e',
                            '#ec4899',
                        ],
                        borderWidth: 0,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '70%',
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            boxWidth: 8,
                            padding: 10,
                            color: '#a1a1aa',
                            font: { size: 9 },
                        },
                    },
                },
            },
        });
    }
    update(summaryData) {
        const byModel = (summaryData && summaryData.byModel) || [];
        const grouped = {};
        for (const item of byModel) {
            if (!item)
                continue;
            const name = (item.model || '').split('/').pop() || 'unknown';
            grouped[name] = (grouped[name] || 0) + (item.total_calls || item.calls || 0);
        }
        const sorted = Object.entries(grouped)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6);
        this.chart.data.labels = sorted.map((x) => x[0]);
        this.chart.data.datasets[0].data = sorted.map((x) => x[1]);
        this.chart.update();
    }
    destroy() {
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
    }
}
