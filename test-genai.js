import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: "foo" });
console.log(Object.keys(GoogleGenAI.prototype))
