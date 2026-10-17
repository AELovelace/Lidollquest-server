const styles=['normal','gentle','baby_talk'];
export function speakingStyleFields(style){
 if(style==null||style==='')return {}; // Omitted style preserves existing persona voice.
 if(!styles.includes(style))throw Error('Unknown speaking_style; choose normal, gentle or baby_talk.');
 return {speaking_style:style};
}
export function speakingStylePrompt(style){
 if(!Object.keys(speakingStyleFields(style)).length)return '';
 return '\n'+JSON.stringify({speaking_style:style})+'\n';
} // The direct model fallback receives the same compact selector the student learns.
