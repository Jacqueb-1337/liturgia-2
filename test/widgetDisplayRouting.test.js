const {routeWidgetForDisplay}=require('../lib/widgetDisplayRouting');
const fs=require('fs'),path=require('path');
test('widget exclusions independently suppress monitor, network, and Stream destinations',()=>{
 const data={obsWidgetUrl:'/obs/alerts/1/index.html',obsWidgetVisible:true,
   obsWidgetExcludedDisplays:['window:2','network:0']};
 expect(routeWidgetForDisplay(data,'window',2).obsWidgetVisible).toBe(false);
 expect(routeWidgetForDisplay(data,'network',0).obsWidgetVisible).toBe(false);
 expect(routeWidgetForDisplay(data,'window',1).obsWidgetVisible).toBe(true);
 expect(routeWidgetForDisplay(data,'network',3).obsWidgetVisible).toBe(true);
 expect(data.obsWidgetVisible).toBe(true);
});
test('widget hide events and normal content updates are not excluded',()=>{
 const data={obsWidgetVisible:false,obsWidgetExcludedDisplays:['network:0']};
 expect(routeWidgetForDisplay(data,'network',0)).toBe(data);
 const scripture={content:'Genesis 1:1',obsWidgetExcludedDisplays:['network:0']};
 expect(routeWidgetForDisplay(scripture,'network',0)).toBe(scripture);
});
test('widget editor saves exclusions and routes via the shared main handler',()=>{
 const root=path.join(__dirname,'..');
 const renderer=fs.readFileSync(path.join(root,'renderer.js'),'utf8');
 const main=fs.readFileSync(path.join(root,'main.js'),'utf8');
 const pkg=require('../package.json');
 expect(renderer).toContain('populateLocalWidgetDisplayExclusions');
 expect(renderer).toContain('excludedDisplays, size:');
 expect(renderer).toContain('obsWidgetExcludedDisplays:');
 expect(main).toContain("routeWidgetForDisplay(overrides[String(displayId)]");
 expect(main).toContain("'network', displayId");
 expect(main).toContain("'window', displayId");
 expect(pkg.build.productName).toBe('Liturgia Worship');
 expect(pkg.build.nsis.shortcutName).toBe('Liturgia Worship');
 expect(pkg.build.appId).toBe('com.jacqueb.liturgia');
});
