'use strict';
function routeWidgetForDisplay(data, kind, id){
  // Presentation display exclusions apply to physical, network and Stream
  // outputs. Keep the operator's Preview/Live canvases unaffected.
  const excludedSlides=Array.isArray(data?.presentationExcludedDisplays)?data.presentationExcludedDisplays:[];
  if(data?.isPresentationSlide && excludedSlides.includes(kind+':'+id)){
    return {...data,mediaPath:null,mediaType:'COLOR',mediaColor:'#000000',
      isMedia:true,number:'',text:'',reference:'',isPresentationSlide:false,
      presentationExcluded:true};
  }
  const excluded=Array.isArray(data?.obsWidgetExcludedDisplays)?data.obsWidgetExcludedDisplays:[];
  if(data?.obsWidgetVisible!==true || !excluded.includes(kind+':'+id))return data;
  return {...data,obsWidgetVisible:false};
}
module.exports={routeWidgetForDisplay};
