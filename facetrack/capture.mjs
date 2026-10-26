// Injectable mediaDevices keeps negotiation regression tests entirely camera-free.
export async function requestCamera(mediaDevices){
  const modes=[{width:{exact:1280},height:{exact:720},frameRate:{ideal:60},facingMode:'user'},
    {width:{ideal:1280},height:{ideal:720},frameRate:{ideal:60},facingMode:'user'},
    {width:{ideal:640},height:{ideal:480},frameRate:{ideal:30},facingMode:'user'}];
  for(let i=0;i<modes.length;i++){
    try{return await mediaDevices.getUserMedia({video:modes[i],audio:false});}
    catch(e){if(!['OverconstrainedError','ConstraintNotSatisfiedError'].includes(e.name)||i===modes.length-1)throw e;}
  }
}
export const shouldDetect=(delegate,now,last)=>delegate==='GPU'||now-last>=66;
