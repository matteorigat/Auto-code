import fs from 'fs';
import yaml from 'yaml';

const filePath = './config/litellm.yaml';
const fileContent = fs.readFileSync(filePath, 'utf8');

const doc = yaml.parseDocument(fileContent);

if (doc.has('model_list')) {
  const modelList = doc.get('model_list');
  for (const model of modelList.items) {
    const modelName = model.get('model_name');
    const litellmParams = model.get('litellm_params');

    if (modelName && litellmParams) {
      let timeoutValue = 120; // default for tier-4
      if (modelName.includes('tier-1-trivial')) {
        timeoutValue = 15;
      } else if (modelName.includes('tier-2-hunter')) {
        timeoutValue = 30;
      } else if (modelName.includes('tier-3-builder')) {
        timeoutValue = 60;
      } else if (modelName.includes('tier-4-planner')) {
        timeoutValue = 120;
      }

      litellmParams.set('timeout', timeoutValue);
    }
  }
}

fs.writeFileSync(filePath, doc.toString(), 'utf8');
console.log('Successfully updated timeouts in litellm.yaml');
