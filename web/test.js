// run-test.js
import { computeMSAConsensus } from './src/services.js';

const scenarioComplex = {
  captions: [
    { text: "Le président a déclaré que la situation est grave." },         // Référence
    { text: "Le president a declarer que la situation est grave" },         // Pas d'accents, pas de point
    { text: "Le président a déclaré la situation est grave." },             // Oubli du "que"
    { text: "Le président a déclaré que la situation est grave !" },        // Ponctuation différente
    { text: "Le président a déclaré que la situation est grave." },         // Correct
    { text: "L'homme a dit que la situation est grave." },                  // Sujet différent
    { text: "Le président a déclaré que la situation est grave." },         // Correct
    { text: "Le président a déclaré que la situation est grave." }          // Correct
  ]
};

console.log("🚀 TEST MSA AVEC 8 CONTRIBUTIONS...");
const startTime = Date.now();

const result = computeMSAConsensus(scenarioComplex);

const duration = Date.now() - startTime;

console.log("\n--- ENTRÉES DU POOL ---");
scenarioComplex.captions.forEach((c, i) => console.log(`[User ${i+1}]: ${c.text}`));

console.log("\n--- RÉSULTAT FINAL ---");
console.log(`Texte : "${result}"`);
console.log(`Temps de calcul : ${duration}ms`);

// Vérification de la robustesse
if (result === "Le président a déclaré que la situation est grave.") {
    console.log("\n✅ SUCCÈS : Le consensus a été trouvé malgré les 8 variantes !");
} else {
    console.log("\n❌ ÉCHEC : Le résultat est différent de l'attendu.");
}