async function main() {
  const res = await fetch('https://ai-prof-project-1.onrender.com/assets/index-D8_AXFB9.js');
  const text = await res.text();
  console.log('Bundle size:', text.length);
  const wsMatches = text.match(/wss?:\/\/[^\s"'`]+/g);
  console.log('WS Matches in deployed bundle:', wsMatches);
  const localhostMatches = text.match(/localhost:[0-9]+/g);
  console.log('Localhost matches in deployed bundle:', localhostMatches);
  const onrenderMatches = text.match(/https?:\/\/[a-zA-Z0-9\-_.]*onrender\.com[^\s"'`]*/g);
  console.log('Onrender matches in deployed bundle:', onrenderMatches);
}

main().catch(console.error);
