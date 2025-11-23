import React from "react";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./ui/collapsible";
import { Button } from "./ui/button";
import { Ellipsis } from "lucide-react";
import { Label } from "./ui/label";
import { Checkbox } from "./ui/checkbox";

interface Props {
  showDelta: boolean;
  setShowDelta: (v: boolean) => void;
}

export const LogViewerOptionsCard: React.FC<Props> = ({ showDelta, setShowDelta }) => {
  return (
    <Card className="p-2 mb-4">
      <Collapsible defaultOpen={true} className="flex flex-wrap justify-between w-full">
        <CardHeader className="p-0">
          <div className="flex items-center justify-around">
            <CardTitle className="text-sm m-0 mr-2">Display Options</CardTitle>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8">
                <Ellipsis />
                <span className="sr-only">Toggle</span>
              </Button>
            </CollapsibleTrigger>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <CollapsibleContent>
            <div className="mt-0">
              <Label htmlFor="toggle-show-delta" className="flex items-start gap-3">
                <Checkbox
                  id="toggle-show-delta"
                  checked={showDelta}
                  onCheckedChange={(checked: boolean | "indeterminate") => setShowDelta(!!checked)}
                  className="data-[state=checked]:border-blue-600 data-[state=checked]:bg-blue-600 data-[state=checked]:text-white dark:data-[state=checked]:border-blue-700 dark:data-[state=checked]:bg-blue-700"
                />
                <div className="grid gap-1.5 font-normal">
                  <p className="text-sm leading-none font-medium">Show time delta</p>
                  <p className="text-muted-foreground text-sm">You can enable or disable showing the time difference between log entries.</p>
                </div>
              </Label>
            </div>
          </CollapsibleContent>
        </CardContent>
      </Collapsible>
    </Card>
  );
};

export default LogViewerOptionsCard;
