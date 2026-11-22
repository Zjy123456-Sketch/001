import { createAnalyzer } from './optimizer.js';

const analyze = createAnalyzer();
self.onmessage = async ({ data: file }) => {
    try {
        const result = await analyze(file, progress => self.postMessage({ progress }));
        self.postMessage({ result });
    } catch (error) {
        self.postMessage({ error: error.message || '读取文件失败。' });
    }
};
