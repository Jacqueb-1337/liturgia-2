'use strict';
function routeWidgetForDisplay(data, kind, id){
  const excluded=Array.isArray(data?.obsWidgetExcludedDisplays)?data.obsWidgetExcludedDisplays:[];
  if(data?.obsWidgetVisible!==true || !excluded.includes(kind+':'+id))return data;
  return {...data,obsWidgetVisible:false};
}
module.exports={routeWidgetForDisplay};
