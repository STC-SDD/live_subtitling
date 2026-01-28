// 1. Fonctions utilitaires
function tokenize(text) { return text.split(/\s+/); }
function detokenize(tokens) { return tokens.join(' '); }

// 2. Logique MSA
function computeMSAConsensus(slot) {
  if (!slot.captions || !slot.captions.length) return "";
  const versions = slot.captions.map(c => tokenize(c.text));
  const maxLength = Math.max(...versions.map(v => v.length));
  const resultTokens = [];

  for (let i = 0; i < maxLength; i++) {
    const frequency = {};
    versions.forEach(tokens => {
      const word = tokens[i];
      if (word) frequency[word] = (frequency[word] || 0) + 1;
    });
    const winner = Object.keys(frequency).reduce((a, b) => 
      (frequency[a] || 0) > (frequency[b] || 0) ? a : b, "");
    if (winner) resultTokens.push(winner);
  }
  
  // Ici, assurez-vous que formalCorrect est accessible ou simulez-la
  return detokenize(typeof formalCorrect !== 'undefined' ? formalCorrect(resultTokens) : resultTokens);
}

// 3. DÉFINITION DES DONNÉES (DOIT ÊTRE ICI)
const mockSlot = {
  captions: [
    { text: "L'intelligence collective de STC est révolutionnaire" },
    { text: "L'intelligence collective de STC est revolutionnaire" },
    { text: "L'intelligence collective de stc est revolutionnaire" },
    { text: "hi hih ihihihihihi" }
  ]
};

// 4. EXÉCUTION DU TEST (TOUJOURS À LA FIN)
console.log("=== RÉSULTAT FINAL (MSA + DICTIONNAIRE) ===");
console.log(`"${computeMSAConsensus(mockSlot)}"`);